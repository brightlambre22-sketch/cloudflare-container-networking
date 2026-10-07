import asyncio
import json
import os
import random
import socket as socket_module
import sys
import time
from dataclasses import dataclass
from typing import Optional

import websockets

from protocol import (
    CLOSE, ERROR, INGRESS_TCP_OPEN, INGRESS_UDP_OPEN, OPEN_TCP, PING, PONG,
    TCP_DATA, TCP_OPENED, UDP_CLOSE, UDP_DATA, UDP_OPEN, UDP_OPENED,
    Frame, decode_frame, encode_frame,
)
from socks5 import decode_udp_packet, open_tcp_connection, open_udp_association

TUNNEL_URL = os.environ.get("TUNNEL_URL", "")
TUNNEL_TOKEN = os.environ.get("TUNNEL_TOKEN", "")
NODE_ID = os.environ.get("NODE_ID", "oracle-gateway")
SOCKS5_PROXY_HOST = os.environ.get("SOCKS5_PROXY_HOST", "")
SOCKS5_PROXY_PORT = int(os.environ.get("SOCKS5_PROXY_PORT", "1080"))
SOCKS5_PROXY_USERNAME = os.environ.get("SOCKS5_PROXY_USERNAME", "")
SOCKS5_PROXY_PASSWORD = os.environ.get("SOCKS5_PROXY_PASSWORD", "")
HEARTBEAT_SECONDS = 25
MAX_STREAMS = 32
MAX_UDP_ASSOCIATIONS = 128
MAX_UDP_INGRESS_SESSIONS = 1024
MAX_TCP_CHUNK = 16384
UDP_IDLE_SECONDS = 120


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"ts": time.time(), "component": "gateway-client", "event": event, **fields}, separators=(",", ":")), flush=True)


def tcp_allowlist() -> set[tuple[str, int]]:
    raw = os.environ.get("TCP_ALLOWLIST", "127.0.0.1:9000")
    allowed: set[tuple[str, int]] = set()
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        host, separator, port_text = item.rpartition(":")
        if not separator or not host or not port_text.isdigit():
            raise ValueError("TCP_ALLOWLIST must contain comma-separated host:port entries")
        port = int(port_text)
        if not 1 <= port <= 65535:
            raise ValueError("TCP_ALLOWLIST port out of range")
        allowed.add((host, port))
    return allowed


def host_port_list(name: str) -> set[tuple[str, int]]:
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
        allowed.add((host.casefold(), port))
    return allowed


def ingress_map(name: str) -> list[tuple[str, int, str, int]]:
    """Parse comma-separated bind-host:port=target-host:port entries."""
    mappings = []
    for item in os.environ.get(name, "").split(","):
        item = item.strip()
        if not item:
            continue
        bind, separator, target = item.partition("=")
        bind_host, bind_colon, bind_port = bind.rpartition(":")
        target_host, target_colon, target_port = target.rpartition(":")
        if (not separator or not bind_colon or not target_colon or not bind_host
                or not target_host or not bind_port.isdigit() or not target_port.isdigit()):
            raise ValueError(f"{name} entries must be bind-host:port=target-host:port")
        public_port, service_port = int(bind_port), int(target_port)
        if not 1 <= public_port <= 65535 or not 1 <= service_port <= 65535:
            raise ValueError(f"{name} port out of range")
        mappings.append((bind_host, public_port, target_host, service_port))
    return mappings


def parse_udp_association(frame: Frame) -> tuple[str, int, bytes]:
    return decode_udp_packet(frame.payload)


@dataclass
class Stream:
    writer: asyncio.StreamWriter
    reader_task: Optional[asyncio.Task] = None
    sequence: int = 0


async def send_frame(socket, lock: asyncio.Lock, frame_type: int, stream_id: int,
                     payload: bytes = b"", sequence: int = 0) -> None:
    wire = encode_frame(frame_type, NODE_ID, stream_id, sequence, payload)
    async with lock:
        await socket.send(wire)


async def send_error(socket, lock: asyncio.Lock, stream_id: int, code: str) -> None:
    await send_frame(socket, lock, ERROR, stream_id, json.dumps({"code": code}).encode())


async def close_stream(streams: dict[int, Stream], stream_id: int) -> None:
    stream = streams.pop(stream_id, None)
    if stream is None:
        return
    current = asyncio.current_task()
    if stream.reader_task is not None and stream.reader_task is not current:
        stream.reader_task.cancel()
        try:
            await stream.reader_task
        except (asyncio.CancelledError, Exception):
            pass
    stream.writer.close()
    try:
        await stream.writer.wait_closed()
    except Exception:
        pass


async def relay_tcp_reader(socket, lock: asyncio.Lock, streams: dict[int, Stream],
                           stream_id: int, stream: Stream, reader: asyncio.StreamReader) -> None:
    try:
        while True:
            data = await reader.read(MAX_TCP_CHUNK)
            if not data:
                break
            stream.sequence = (stream.sequence + 1) & 0xFFFFFFFF
            await send_frame(socket, lock, TCP_DATA, stream_id, data, stream.sequence)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        emit("tcp_read_failed", stream_id=stream_id, error_type=type(error).__name__)
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


@dataclass
class EgressUdp:
    control_writer: asyncio.StreamWriter
    datagram_socket: socket_module.socket
    response_task: Optional[asyncio.Task] = None


@dataclass
class IngressUdp:
    transport: asyncio.DatagramTransport
    peer: tuple[str, int]
    target_host: str
    target_port: int
    opened: bool = False
    pending: list[bytes] | None = None
    last_seen: float = 0.0


async def open_udp_egress(socket, lock, associations, frame: Frame) -> None:
    if frame.stream_id == 0 or frame.stream_id in associations:
        await send_error(socket, lock, frame.stream_id, "invalid_or_duplicate_association")
        return
    if len(associations) >= MAX_UDP_ASSOCIATIONS:
        await send_error(socket, lock, frame.stream_id, "udp_association_limit")
        return
    if not SOCKS5_PROXY_HOST:
        await send_error(socket, lock, frame.stream_id, "socks5_proxy_not_configured")
        return
    try:
        _, control_writer, udp_socket = await open_udp_association(
            SOCKS5_PROXY_HOST, SOCKS5_PROXY_PORT,
            SOCKS5_PROXY_USERNAME, SOCKS5_PROXY_PASSWORD,
        )
    except Exception as error:
        await send_error(socket, lock, frame.stream_id, "socks5_udp_associate_failed")
        emit("socks5_udp_associate_failed", stream_id=frame.stream_id,
             error_type=type(error).__name__)
        return
    association = EgressUdp(control_writer, udp_socket)
    associations[frame.stream_id] = association
    await send_frame(socket, lock, UDP_OPENED, frame.stream_id)

    async def receive_replies():
        try:
            loop = asyncio.get_running_loop()
            while True:
                packet = await loop.sock_recv(udp_socket, 65535)
                if packet:
                    await send_frame(socket, lock, UDP_DATA, frame.stream_id, packet)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit("socks5_udp_receive_failed", stream_id=frame.stream_id,
                 error_type=type(error).__name__)
        finally:
            if associations.get(frame.stream_id) is association:
                associations.pop(frame.stream_id, None)
                udp_socket.close()
                control_writer.close()
                try:
                    await control_writer.wait_closed()
                except Exception:
                    pass
                try:
                    await send_frame(socket, lock, UDP_CLOSE, frame.stream_id)
                except Exception:
                    pass

    association.response_task = asyncio.create_task(receive_replies())
    emit("socks5_udp_association_opened", stream_id=frame.stream_id)


async def close_udp_egress(associations: dict[int, EgressUdp], stream_id: int) -> None:
    association = associations.pop(stream_id, None)
    if not association:
        return
    if association.response_task and association.response_task is not asyncio.current_task():
        association.response_task.cancel()
        try:
            await association.response_task
        except (asyncio.CancelledError, Exception):
            pass
    association.datagram_socket.close()
    association.control_writer.close()
    try:
        await association.control_writer.wait_closed()
    except Exception:
        pass


class PublicUdpProtocol(asyncio.DatagramProtocol):
    def __init__(self, socket, lock, sessions, target_host, target_port, next_id):
        self.socket, self.lock, self.sessions = socket, lock, sessions
        self.target_host, self.target_port, self.next_id = target_host, target_port, next_id
        self.transport = None
        self.by_peer: dict[tuple[str, int], int] = {}

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:
        peer = (addr[0], addr[1])
        stream_id = self.by_peer.get(peer)
        session = self.sessions.get(stream_id) if stream_id else None
        if session is None:
            if len(self.sessions) >= MAX_UDP_INGRESS_SESSIONS:
                return
            stream_id = self.next_id()
            self.by_peer[peer] = stream_id
            session = IngressUdp(self.transport, peer, self.target_host, self.target_port,
                                 False, [], time.monotonic())
            self.sessions[stream_id] = session
            session.pending.append(data)
            asyncio.create_task(send_frame(
                self.socket, self.lock, INGRESS_UDP_OPEN, stream_id,
                json.dumps({"host": self.target_host, "port": self.target_port}).encode(),
            ))
            return
        session.last_seen = time.monotonic()
        if not session.opened:
            if session.pending is not None and len(session.pending) < 8:
                session.pending.append(data)
            return
        asyncio.create_task(send_frame(self.socket, self.lock, UDP_DATA, stream_id, data))

    def error_received(self, error):
        emit("public_udp_listener_error", error_type=type(error).__name__)


async def accept_public_tcp(socket, lock, streams, reader, writer, target_host,
                            target_port, next_id) -> None:
    stream_id = next_id()
    if len(streams) >= 128:
        writer.close()
        await writer.wait_closed()
        return
    stream = Stream(writer)
    streams[stream_id] = stream
    try:
        await send_frame(
            socket, lock, INGRESS_TCP_OPEN, stream_id,
            json.dumps({"host": target_host, "port": target_port}).encode(),
        )
        stream.reader_task = asyncio.create_task(
            relay_tcp_reader(socket, lock, streams, stream_id, stream, reader)
        )
        emit("public_tcp_ingress_opened", stream_id=stream_id,
             target=f"{target_host}:{target_port}")
    except Exception:
        await close_stream(streams, stream_id)


async def expire_ingress_udp(socket, lock, sessions) -> None:
    while True:
        await asyncio.sleep(30)
        now = time.monotonic()
        for stream_id, session in list(sessions.items()):
            if now - session.last_seen > UDP_IDLE_SECONDS:
                sessions.pop(stream_id, None)
                try:
                    await send_frame(socket, lock, UDP_CLOSE, stream_id)
                except Exception:
                    pass


async def open_tcp(socket, lock: asyncio.Lock, streams: dict[int, Stream], frame: Frame,
                   allowed: set[tuple[str, int]],
                   direct_allowed: set[tuple[str, int]]) -> None:
    if frame.stream_id == 0 or frame.stream_id in streams:
        await send_error(socket, lock, frame.stream_id, "invalid_or_duplicate_stream")
        return
    if len(streams) >= MAX_STREAMS:
        await send_error(socket, lock, frame.stream_id, "stream_limit")
        return
    try:
        request = json.loads(frame.payload.decode("utf-8"))
        host = request.get("host")
        port = request.get("port")
        if not isinstance(host, str) or not isinstance(port, int) or isinstance(port, bool):
            raise ValueError("invalid_target")
        if not 1 <= port <= 65535 or (host, port) not in allowed:
            await send_error(socket, lock, frame.stream_id, "destination_not_allowlisted")
            return
        if (host, port) in direct_allowed:
            reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=8)
        else:
            if not SOCKS5_PROXY_HOST:
                await send_error(socket, lock, frame.stream_id, "socks5_proxy_not_configured")
                return
            reader, writer = await open_tcp_connection(
                SOCKS5_PROXY_HOST, SOCKS5_PROXY_PORT, host, port,
                SOCKS5_PROXY_USERNAME, SOCKS5_PROXY_PASSWORD,
            )
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, ValueError):
        await send_error(socket, lock, frame.stream_id, "invalid_target")
        return
    except Exception as error:
        await send_error(socket, lock, frame.stream_id, "connect_failed")
        emit("tcp_connect_failed", stream_id=frame.stream_id, error_type=type(error).__name__)
        return

    stream = Stream(writer=writer)
    streams[frame.stream_id] = stream
    await send_frame(socket, lock, TCP_OPENED, frame.stream_id,
                     json.dumps({"host": host, "port": port}).encode())
    stream.reader_task = asyncio.create_task(
        relay_tcp_reader(socket, lock, streams, frame.stream_id, stream, reader)
    )
    emit("tcp_stream_opened", stream_id=frame.stream_id, destination=f"{host}:{port}")


async def handle_frame(socket, lock: asyncio.Lock, streams: dict[int, Stream],
                       frame: Frame, allowed: set[tuple[str, int]],
                       direct_allowed: set[tuple[str, int]],
                       udp_allowed: set[tuple[str, int]],
                       udp_egress: dict[int, EgressUdp],
                       udp_ingress: dict[int, IngressUdp]) -> None:
    if frame.frame_type == OPEN_TCP:
        await open_tcp(socket, lock, streams, frame, allowed, direct_allowed)
        return
    if frame.frame_type == TCP_OPENED:
        return
    if frame.frame_type == TCP_DATA:
        stream = streams.get(frame.stream_id)
        if stream is None:
            await send_error(socket, lock, frame.stream_id, "unknown_stream")
            return
        try:
            stream.writer.write(frame.payload)
            await asyncio.wait_for(stream.writer.drain(), timeout=15)
        except Exception as error:
            emit("tcp_write_failed", stream_id=frame.stream_id, error_type=type(error).__name__)
            await close_stream(streams, frame.stream_id)
            await send_error(socket, lock, frame.stream_id, "write_failed")
        return
    if frame.frame_type == CLOSE:
        await close_stream(streams, frame.stream_id)
        return
    if frame.frame_type == UDP_OPEN:
        await open_udp_egress(socket, lock, udp_egress, frame)
        return
    if frame.frame_type == UDP_OPENED:
        session = udp_ingress.get(frame.stream_id)
        if session:
            session.opened = True
            session.last_seen = time.monotonic()
            for packet in session.pending or []:
                await send_frame(socket, lock, UDP_DATA, frame.stream_id, packet)
            session.pending = []
        return
    if frame.frame_type == UDP_DATA:
        association = udp_egress.get(frame.stream_id)
        if association:
            try:
                host, port, _ = decode_udp_packet(frame.payload)
                if (host.casefold(), port) not in udp_allowed:
                    await send_error(socket, lock, frame.stream_id, "udp_destination_not_allowlisted")
                    return
                association.datagram_socket.send(frame.payload)
            except (ValueError, OSError) as error:
                await send_error(socket, lock, frame.stream_id, "invalid_or_failed_udp_datagram")
                emit("udp_egress_send_failed", stream_id=frame.stream_id,
                     error_type=type(error).__name__)
            return
        session = udp_ingress.get(frame.stream_id)
        if session:
            session.last_seen = time.monotonic()
            session.transport.sendto(frame.payload, session.peer)
        else:
            await send_error(socket, lock, frame.stream_id, "unknown_udp_association")
        return
    if frame.frame_type == UDP_CLOSE:
        if frame.stream_id in udp_egress:
            await close_udp_egress(udp_egress, frame.stream_id)
        if frame.stream_id in udp_ingress:
            udp_ingress.pop(frame.stream_id, None)
        return
    if frame.frame_type == ERROR:
        await close_stream(streams, frame.stream_id)
        if frame.stream_id in udp_egress:
            await close_udp_egress(udp_egress, frame.stream_id)
        udp_ingress.pop(frame.stream_id, None)
        emit("peer_reported_error", stream_id=frame.stream_id)
        return
    if frame.frame_type in (PING, PONG):
        return
    await send_error(socket, lock, frame.stream_id, "unsupported_gateway_frame")


async def heartbeat(socket, lock: asyncio.Lock) -> None:
    while True:
        await send_frame(socket, lock, PING, 0, str(time.time()).encode())
        await asyncio.sleep(HEARTBEAT_SECONDS)


async def run_connection(allowed: set[tuple[str, int]], direct_allowed, udp_allowed,
                         tcp_ingress, udp_ingress_mappings) -> None:
    headers = {
        "Authorization": f"Bearer {TUNNEL_TOKEN}",
        "X-Node-ID": NODE_ID,
        "X-Tunnel-Role": "gateway",
    }
    async with websockets.connect(
        TUNNEL_URL,
        extra_headers=headers,
        ping_interval=20,
        open_timeout=15,
        close_timeout=5,
        max_size=70000,
    ) as socket:
        emit("connected", node_id=NODE_ID)
        send_lock = asyncio.Lock()
        streams: dict[int, Stream] = {}
        udp_egress: dict[int, EgressUdp] = {}
        udp_ingress: dict[int, IngressUdp] = {}
        ingress_id = random.randrange(0, 1 << 30) | 0x80000001

        def next_ingress_id():
            nonlocal ingress_id
            ingress_id = (ingress_id + 2) & 0xFFFFFFFF
            if ingress_id < 0x80000001:
                ingress_id = 0x80000001
            return ingress_id

        tcp_servers = []
        udp_transports = []
        for bind_host, bind_port, target_host, target_port in tcp_ingress:
            server = await asyncio.start_server(
                lambda r, w, th=target_host, tp=target_port: accept_public_tcp(
                    socket, send_lock, streams, r, w, th, tp, next_ingress_id
                ),
                bind_host, bind_port,
            )
            tcp_servers.append(server)
            emit("public_tcp_listener_ready", bind=f"{bind_host}:{bind_port}",
                 target=f"{target_host}:{target_port}")

        for bind_host, bind_port, target_host, target_port in udp_ingress_mappings:
            protocol_factory = lambda bh=bind_host, bp=bind_port, th=target_host, tp=target_port: PublicUdpProtocol(
                socket, send_lock, udp_ingress, th, tp, next_ingress_id
            )
            transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
                protocol_factory, local_addr=(bind_host, bind_port)
            )
            udp_transports.append(transport)
            emit("public_udp_listener_ready", bind=f"{bind_host}:{bind_port}",
                 target=f"{target_host}:{target_port}")

        ping_task = asyncio.create_task(heartbeat(socket, send_lock))
        udp_expiry_task = asyncio.create_task(expire_ingress_udp(socket, send_lock, udp_ingress))
        try:
            async for message in socket:
                if not isinstance(message, bytes):
                    emit("unexpected_text_message")
                    continue
                try:
                    frame = decode_frame(message)
                    if frame.node_id != NODE_ID:
                        emit("node_id_mismatch")
                        continue
                    await handle_frame(socket, send_lock, streams, frame, allowed, direct_allowed,
                                       udp_allowed, udp_egress, udp_ingress)
                except ValueError as error:
                    emit("invalid_frame", reason=str(error))
        finally:
            ping_task.cancel()
            udp_expiry_task.cancel()
            for server in tcp_servers:
                server.close()
            for server in tcp_servers:
                await server.wait_closed()
            for transport in udp_transports:
                transport.close()
            for stream_id in list(udp_egress):
                await close_udp_egress(udp_egress, stream_id)
            udp_ingress.clear()
            try:
                await ping_task
            except asyncio.CancelledError:
                pass
            try:
                await udp_expiry_task
            except asyncio.CancelledError:
                pass
            for stream_id in list(streams):
                await close_stream(streams, stream_id)
        emit("disconnected", node_id=NODE_ID)


async def main() -> None:
    if not TUNNEL_URL.startswith("wss://") or not TUNNEL_TOKEN:
        emit("configuration_error", required=["TUNNEL_URL (wss://...)", "TUNNEL_TOKEN"])
        raise SystemExit(2)
    if not 1 <= SOCKS5_PROXY_PORT <= 65535:
        emit("configuration_error", reason="SOCKS5_PROXY_PORT must be between 1 and 65535")
        raise SystemExit(2)
    try:
        allowed = tcp_allowlist()
        direct_allowed = (
            host_port_list("TCP_DIRECT_ALLOWLIST")
            if "TCP_DIRECT_ALLOWLIST" in os.environ
            else {("127.0.0.1", 9000)}
        )
        udp_allowed = host_port_list("UDP_DESTINATION_ALLOWLIST")
        tcp_ingress = ingress_map("TCP_INGRESS_MAP")
        udp_ingress_mappings = ingress_map("UDP_INGRESS_MAP")
    except ValueError as error:
        emit("configuration_error", reason=str(error))
        raise SystemExit(2) from error
    delay = 1.0
    while True:
        try:
            await run_connection(allowed, direct_allowed, udp_allowed,
                                 tcp_ingress, udp_ingress_mappings)
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
