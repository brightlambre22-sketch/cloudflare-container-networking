"""Node-side tunnel agent: allowlisted ingress plus an optional local SOCKS5 UDP endpoint."""

import asyncio
import ipaddress
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from typing import Optional

import websockets

from protocol import (
    CLOSE, ERROR, INGRESS_TCP_OPEN, INGRESS_UDP_OPEN, PING, PONG,
    OPEN_TCP, TCP_DATA, TCP_OPENED, UDP_CLOSE, UDP_DATA, UDP_OPEN, UDP_OPENED,
    Frame, decode_frame, encode_frame,
)
from socks5 import decode_udp_packet

TUNNEL_URL = os.environ.get("TUNNEL_URL", "")
CLIENT_TOKEN = os.environ.get("CLIENT_TOKEN", "")
NODE_ID = os.environ.get("NODE_ID", "")
MAX_TCP_CHUNK = 16384
MAX_UDP_ASSOCIATIONS = 128


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"ts": time.time(), "component": "node-agent", "event": event, **fields},
                     separators=(",", ":")), flush=True)


def parse_allowlist(name: str) -> set[tuple[str, int]]:
    allowed: set[tuple[str, int]] = set()
    for item in os.environ.get(name, "").split(","):
        item = item.strip()
        if not item:
            continue
        host, separator, port_text = item.rpartition(":")
        if not separator or not host or not port_text.isdigit():
            raise ValueError(f"{name} must contain comma-separated host:port entries")
        port = int(port_text)
        if not 1 <= port <= 65535:
            raise ValueError(f"{name} port out of range")
        allowed.add((host, port))
    return allowed


@dataclass
class Stream:
    writer: asyncio.StreamWriter
    reader_task: Optional[asyncio.Task] = None
    sequence: int = 0


@dataclass
class UdpFlow:
    transport: asyncio.DatagramTransport | None
    mode: str
    client_peer: tuple[str, int] | None = None
    opened: asyncio.Event | None = None


async def send_frame(socket, lock: asyncio.Lock, frame_type: int, stream_id: int,
                     payload: bytes = b"", sequence: int = 0) -> None:
    async with lock:
        await socket.send(encode_frame(frame_type, NODE_ID, stream_id, sequence, payload))


async def send_error(socket, lock: asyncio.Lock, stream_id: int, code: str) -> None:
    await send_frame(socket, lock, ERROR, stream_id, json.dumps({"code": code}).encode())


async def close_stream(streams: dict[int, Stream], stream_id: int) -> None:
    stream = streams.pop(stream_id, None)
    if stream is None:
        return
    task = stream.reader_task
    if task and task is not asyncio.current_task():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    stream.writer.close()
    try:
        await stream.writer.wait_closed()
    except Exception:
        pass


async def relay_reader(socket, lock, streams, stream_id, stream, reader) -> None:
    try:
        while data := await reader.read(MAX_TCP_CHUNK):
            stream.sequence = (stream.sequence + 1) & 0xFFFFFFFF
            await send_frame(socket, lock, TCP_DATA, stream_id, data, stream.sequence)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        emit("ingress_read_failed", stream_id=stream_id, error_type=type(error).__name__)
    finally:
        if streams.get(stream_id) is stream:
            streams.pop(stream_id, None)
            stream.writer.close()
            try:
                await stream.writer.wait_closed()
            except Exception:
                pass
            try:
                await send_frame(socket, lock, CLOSE, stream_id)
            except Exception:
                pass


async def open_ingress_tcp(socket, lock, streams, frame, allowed) -> None:
    if frame.stream_id == 0 or frame.stream_id in streams:
        await send_error(socket, lock, frame.stream_id, "invalid_or_duplicate_stream")
        return
    if len(streams) >= 128:
        await send_error(socket, lock, frame.stream_id, "stream_limit")
        return
    try:
        target = json.loads(frame.payload.decode("utf-8"))
        host, port = target.get("host"), target.get("port")
        if not isinstance(host, str) or not isinstance(port, int) or isinstance(port, bool):
            raise ValueError
        if not 1 <= port <= 65535 or (host, port) not in allowed:
            await send_error(socket, lock, frame.stream_id, "destination_not_allowlisted")
            return
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=8)
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, ValueError):
        await send_error(socket, lock, frame.stream_id, "invalid_target")
        return
    except Exception as error:
        await send_error(socket, lock, frame.stream_id, "connect_failed")
        emit("ingress_connect_failed", stream_id=frame.stream_id, error_type=type(error).__name__)
        return
    stream = Stream(writer)
    streams[frame.stream_id] = stream
    await send_frame(socket, lock, TCP_OPENED, frame.stream_id)
    stream.reader_task = asyncio.create_task(
        relay_reader(socket, lock, streams, frame.stream_id, stream, reader)
    )


class NodeUdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, socket, lock, stream_id, flow, flows):
        self.socket, self.lock, self.stream_id, self.flow, self.flows = socket, lock, stream_id, flow, flows

    def datagram_received(self, data: bytes, addr) -> None:
        if self.flow.mode == "local-socks":
            try:
                decode_udp_packet(data)
            except ValueError as error:
                emit("invalid_local_udp_packet", reason=str(error))
                return
            self.flow.client_peer = (addr[0], addr[1])
        asyncio.create_task(send_frame(self.socket, self.lock, UDP_DATA, self.stream_id, data))

    def error_received(self, error: Exception) -> None:
        emit("udp_socket_error", stream_id=self.stream_id, error_type=type(error).__name__)

    def connection_lost(self, error) -> None:
        self.flows.pop(self.stream_id, None)


async def open_ingress_udp(socket, lock, frame, flows, allowed) -> None:
    if frame.stream_id == 0 or frame.stream_id in flows:
        await send_error(socket, lock, frame.stream_id, "invalid_or_duplicate_association")
        return
    if len(flows) >= MAX_UDP_ASSOCIATIONS:
        await send_error(socket, lock, frame.stream_id, "udp_association_limit")
        return
    try:
        target = json.loads(frame.payload.decode("utf-8"))
        host, port = target.get("host"), target.get("port")
        if not isinstance(host, str) or not isinstance(port, int) or isinstance(port, bool):
            raise ValueError
        if not 1 <= port <= 65535 or (host, port) not in allowed:
            await send_error(socket, lock, frame.stream_id, "destination_not_allowlisted")
            return
        loop = asyncio.get_running_loop()
        flow = UdpFlow(None, "ingress")
        transport, _ = await loop.create_datagram_endpoint(
            lambda: NodeUdpProtocol(socket, lock, frame.stream_id, flow, flows),
            remote_addr=(host, port),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, ValueError):
        await send_error(socket, lock, frame.stream_id, "invalid_target")
        return
    except Exception as error:
        await send_error(socket, lock, frame.stream_id, "udp_connect_failed")
        emit("ingress_udp_connect_failed", stream_id=frame.stream_id, error_type=type(error).__name__)
        return
    flow.transport = transport
    flows[frame.stream_id] = flow
    await send_frame(socket, lock, UDP_OPENED, frame.stream_id)


async def read_socks_target(reader, atyp, allow_zero_port=False):
    if atyp == 1:
        host = str(ipaddress.ip_address(await reader.readexactly(4)))
    elif atyp == 4:
        host = str(ipaddress.ip_address(await reader.readexactly(16)))
    elif atyp == 3:
        length = (await reader.readexactly(1))[0]
        if length == 0:
            raise ValueError("empty_socks5_hostname")
        host = (await reader.readexactly(length)).decode("idna")
    else:
        raise ValueError("unsupported_socks5_address_type")
    port = int.from_bytes(await reader.readexactly(2), "big")
    if not 0 <= port <= 65535 or (port == 0 and not allow_zero_port):
        raise ValueError("invalid_socks5_port")
    return host, port


async def handle_socks_control(reader, writer, socket, lock, flows, streams,
                               open_waiters, open_errors, next_id) -> None:
    stream_id = next_id()
    flow = None
    keep_tcp = False
    try:
        version, method_count = await asyncio.wait_for(reader.readexactly(2), 10)
        methods = await reader.readexactly(method_count)
        if version != 5 or 0 not in methods:
            writer.write(b"\x05\xff")
            await writer.drain()
            return
        writer.write(b"\x05\x00")
        await writer.drain()
        version, command, reserved, atyp = await asyncio.wait_for(reader.readexactly(4), 10)
        if version != 5 or command not in (1, 3) or reserved != 0:
            writer.write(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            return
        try:
            host, port = await read_socks_target(reader, atyp, allow_zero_port=(command == 3))
        except (ValueError, UnicodeError):
            writer.write(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            return

        if command == 1:
            stream = Stream(writer)
            streams[stream_id] = stream
            opened = asyncio.Event()
            open_waiters[stream_id] = opened
            await send_frame(
                socket, lock, OPEN_TCP, stream_id,
                json.dumps({"host": host, "port": port}).encode(),
            )
            try:
                await asyncio.wait_for(opened.wait(), 15)
            except asyncio.TimeoutError:
                open_errors[stream_id] = "connect_timeout"
            error_code = open_errors.pop(stream_id, None)
            open_waiters.pop(stream_id, None)
            if error_code:
                streams.pop(stream_id, None)
                writer.write(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
                await writer.drain()
                return
            writer.write(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
            await writer.drain()
            keep_tcp = True
            stream.reader_task = asyncio.create_task(
                relay_reader(socket, lock, streams, stream_id, stream, reader)
            )
            return

        if len(flows) >= MAX_UDP_ASSOCIATIONS:
            writer.write(b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            return
        loop = asyncio.get_running_loop()
        flow = UdpFlow(None, "local-socks")
        transport, _ = await loop.create_datagram_endpoint(
            lambda: NodeUdpProtocol(socket, lock, stream_id, flow, flows),
            local_addr=("127.0.0.1", 0),
        )
        flow.transport = transport
        flow.opened = asyncio.Event()
        flows[stream_id] = flow
        await send_frame(socket, lock, UDP_OPEN, stream_id)
        try:
            await asyncio.wait_for(flow.opened.wait(), timeout=12)
        except asyncio.TimeoutError:
            flows.pop(stream_id, None)
            transport.close()
            writer.write(b"\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
            return
        relay_host, relay_port = transport.get_extra_info("sockname")[:2]
        writer.write(b"\x05\x00\x00\x01" + ipaddress.ip_address(relay_host).packed
                     + int(relay_port).to_bytes(2, "big"))
        await writer.drain()
        await reader.read()
    except (asyncio.IncompleteReadError, ConnectionError, OSError, asyncio.TimeoutError):
        pass
    finally:
        if flow is not None:
            flows.pop(stream_id, None)
            if flow.transport:
                flow.transport.close()
            try:
                await send_frame(socket, lock, UDP_CLOSE, stream_id)
            except Exception:
                pass
        if not keep_tcp:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


async def handle_frame(socket, lock, streams, flows, frame, ingress_tcp_allowed,
                       ingress_udp_allowed, open_waiters, open_errors) -> None:
    if frame.frame_type == INGRESS_TCP_OPEN:
        await open_ingress_tcp(socket, lock, streams, frame, ingress_tcp_allowed)
        return
    if frame.frame_type == INGRESS_UDP_OPEN:
        await open_ingress_udp(socket, lock, frame, flows, ingress_udp_allowed)
        return
    if frame.frame_type == TCP_DATA:
        stream = streams.get(frame.stream_id)
        if not stream:
            await send_error(socket, lock, frame.stream_id, "unknown_stream")
            return
        try:
            stream.writer.write(frame.payload)
            await asyncio.wait_for(stream.writer.drain(), 15)
        except Exception:
            await close_stream(streams, frame.stream_id)
            await send_error(socket, lock, frame.stream_id, "write_failed")
        return
    if frame.frame_type == TCP_OPENED:
        waiter = open_waiters.get(frame.stream_id)
        if waiter:
            waiter.set()
        return
    if frame.frame_type == ERROR:
        if frame.stream_id in open_waiters:
            open_errors[frame.stream_id] = "connect_failed"
            open_waiters[frame.stream_id].set()
        else:
            await close_stream(streams, frame.stream_id)
            flow = flows.pop(frame.stream_id, None)
            if flow and flow.transport:
                flow.transport.close()
        return
    if frame.frame_type == CLOSE:
        await close_stream(streams, frame.stream_id)
        return
    if frame.frame_type == UDP_OPENED:
        flow = flows.get(frame.stream_id)
        if flow and flow.opened:
            flow.opened.set()
        return
    if frame.frame_type == UDP_DATA:
        flow = flows.get(frame.stream_id)
        if flow is None:
            await send_error(socket, lock, frame.stream_id, "unknown_association")
        elif flow.mode == "local-socks":
            if flow.client_peer and flow.transport:
                flow.transport.sendto(frame.payload, flow.client_peer)
        else:
            if flow.transport:
                flow.transport.sendto(frame.payload)
        return
    if frame.frame_type == UDP_CLOSE:
        flow = flows.pop(frame.stream_id, None)
        if flow and flow.transport:
            flow.transport.close()
        return
    if frame.frame_type in (PING, PONG):
        return
    await send_error(socket, lock, frame.stream_id, "unsupported_node_frame")


async def run_connection(tcp_allowed, udp_allowed) -> None:
    headers = {
        "Authorization": f"Bearer {CLIENT_TOKEN}",
        "X-Node-ID": NODE_ID,
        "X-Tunnel-Role": "client",
    }
    async with websockets.connect(TUNNEL_URL, extra_headers=headers, ping_interval=20,
                                  open_timeout=15, close_timeout=5, max_size=70000) as socket:
        emit("connected", node_id=NODE_ID)
        lock = asyncio.Lock()
        streams: dict[int, Stream] = {}
        flows: dict[int, UdpFlow] = {}
        open_waiters: dict[int, asyncio.Event] = {}
        open_errors: dict[int, str] = {}
        counter = random.randrange(1, 1 << 30) & 0x7FFFFFFE
        if counter == 0:
            counter = 2

        def next_id():
            nonlocal counter
            counter = (counter + 2) & 0x7FFFFFFF
            return counter or 2

        local_server = None
        local_socks = os.environ.get("LOCAL_SOCKS5_LISTEN", "")
        if local_socks:
            host, separator, port_text = local_socks.rpartition(":")
            if (not separator or host not in ("127.0.0.1", "::1")
                    or not port_text.isdigit() or not 1 <= int(port_text) <= 65535):
                raise ValueError("LOCAL_SOCKS5_LISTEN must be loopback host:port with a valid port")
            local_server = await asyncio.start_server(
                lambda r, w: handle_socks_control(
                    r, w, socket, lock, flows, streams, open_waiters, open_errors, next_id
                ),
                host, int(port_text),
            )
            emit("local_socks5_udp_ready", listen=local_socks)
        ping_task = asyncio.create_task(heartbeat(socket, lock))
        try:
            async for message in socket:
                if not isinstance(message, bytes):
                    continue
                try:
                    frame = decode_frame(message)
                    if frame.node_id != NODE_ID:
                        emit("node_id_mismatch")
                        continue
                    await handle_frame(socket, lock, streams, flows, frame,
                                       tcp_allowed, udp_allowed, open_waiters, open_errors)
                except ValueError as error:
                    emit("invalid_frame", reason=str(error))
        finally:
            ping_task.cancel()
            if local_server:
                local_server.close()
                await local_server.wait_closed()
            for stream_id in list(streams):
                await close_stream(streams, stream_id)
            for flow in flows.values():
                if flow.transport:
                    flow.transport.close()
            flows.clear()
            try:
                await ping_task
            except asyncio.CancelledError:
                pass


async def heartbeat(socket, lock) -> None:
    while True:
        await send_frame(socket, lock, PING, 0, str(time.time()).encode())
        await asyncio.sleep(25)


async def main() -> None:
    if not TUNNEL_URL.startswith("wss://") or not CLIENT_TOKEN or not NODE_ID:
        emit("configuration_error", required=["TUNNEL_URL (wss://...)", "CLIENT_TOKEN", "NODE_ID"])
        raise SystemExit(2)
    local_socks = os.environ.get("LOCAL_SOCKS5_LISTEN", "")
    if local_socks:
        host, separator, port_text = local_socks.rpartition(":")
        if (not separator or host not in ("127.0.0.1", "::1")
                or not port_text.isdigit() or not 1 <= int(port_text) <= 65535):
            emit("configuration_error", reason="LOCAL_SOCKS5_LISTEN must be loopback host:port with a valid port")
            raise SystemExit(2)
    try:
        tcp_allowed = parse_allowlist("INGRESS_TCP_ALLOWLIST")
        udp_allowed = parse_allowlist("INGRESS_UDP_ALLOWLIST")
    except ValueError as error:
        emit("configuration_error", reason=str(error))
        raise SystemExit(2) from error
    delay = 1.0
    while True:
        try:
            await run_connection(tcp_allowed, udp_allowed)
            delay = 1.0
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit("connection_failed", node_id=NODE_ID, error_type=type(error).__name__)
        wait = min(30.0, delay) * random.uniform(0.8, 1.2)
        emit("reconnecting", delay_seconds=round(wait, 2))
        await asyncio.sleep(wait)
        delay = min(30.0, delay * 2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
