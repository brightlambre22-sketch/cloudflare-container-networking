import asyncio
import unittest

import node_agent
from protocol import (
    CLOSE, INGRESS_TCP_OPEN, INGRESS_UDP_OPEN, OPEN_TCP, TCP_DATA, TCP_OPENED,
    UDP_CLOSE, UDP_DATA, UDP_OPENED, Frame, decode_frame,
)
from socks5 import encode_udp_packet


class AutoTunnel:
    def __init__(self, flows, open_waiters):
        self.flows = flows
        self.open_waiters = open_waiters
        self.frames = []
        self.changed = asyncio.Condition()

    async def send(self, wire):
        frame = decode_frame(wire)
        self.frames.append(frame)
        async with self.changed:
            self.changed.notify_all()
        if frame.frame_type == OPEN_TCP and frame.stream_id in self.open_waiters:
            self.open_waiters[frame.stream_id].set()
        if frame.frame_type == 10 and frame.stream_id in self.flows:
            flow = self.flows[frame.stream_id]
            if flow.opened:
                flow.opened.set()

    async def wait_for_type(self, frame_type):
        async def find():
            while True:
                for frame in self.frames:
                    if frame.frame_type == frame_type:
                        return frame
                await self.changed.wait()
        async with self.changed:
            return await asyncio.wait_for(find(), 2)


class NodeAgentProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        node_agent.NODE_ID = "test-node"
        self.flows = {}
        self.streams = {}
        self.open_waiters = {}
        self.open_errors = {}
        self.tunnel = AutoTunnel(self.flows, self.open_waiters)
        self.lock = asyncio.Lock()
        self.server = await asyncio.start_server(
            lambda r, w: node_agent.handle_socks_control(
                r, w, self.tunnel, self.lock, self.flows, self.streams,
                self.open_waiters, self.open_errors, lambda: 22,
            ),
            "127.0.0.1", 0,
        )
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def handshake(self, command, address):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(b"\x05\x01\x00")
        await writer.drain()
        self.assertEqual(await reader.readexactly(2), b"\x05\x00")
        writer.write(bytes((5, command, 0)) + address)
        await writer.drain()
        response = await reader.readexactly(4)
        self.assertEqual(response[:2], b"\x05\x00")
        atyp = response[3]
        if atyp == 1:
            relay_host = ".".join(map(str, await reader.readexactly(4)))
        elif atyp == 4:
            import socket
            relay_host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
        else:
            length = (await reader.readexactly(1))[0]
            relay_host = (await reader.readexactly(length)).decode()
        relay_port = int.from_bytes(await reader.readexactly(2), "big")
        return reader, writer, relay_host, relay_port

    async def test_udp_associate_accepts_zero_address_and_relays_datagrams(self):
        reader, control, relay_host, relay_port = await self.handshake(
            3, b"\x01\x00\x00\x00\x00\x00\x00"
        )
        self.assertEqual(relay_host, "127.0.0.1")
        import socket
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sender.setblocking(False)
        sender.bind(("127.0.0.1", 0))
        outgoing = encode_udp_packet("192.0.2.8", 53, b"query")
        await asyncio.get_running_loop().sock_sendto(sender, outgoing, (relay_host, relay_port))
        frame = await self.tunnel.wait_for_type(UDP_DATA)
        self.assertEqual(frame.payload, outgoing)

        response = encode_udp_packet("192.0.2.8", 53, b"reply")
        await node_agent.handle_frame(
            self.tunnel, self.lock, self.streams, self.flows,
            Frame(UDP_DATA, 0, "test-node", frame.stream_id, 0, response),
            set(), set(), self.open_waiters, self.open_errors,
        )
        received, _ = await asyncio.wait_for(
            asyncio.get_running_loop().sock_recvfrom(sender, 2048), 2
        )
        self.assertEqual(received, response)
        sender.close()
        control.close()
        await control.wait_closed()
        await self.tunnel.wait_for_type(UDP_CLOSE)

    async def test_tcp_connect_uses_tunnel_frames(self):
        reader, control, _, _ = await self.handshake(
            1, b"\x01\xc0\x00\x02\x01\x01\xbb"
        )
        frame = await self.tunnel.wait_for_type(OPEN_TCP)
        self.assertEqual(frame.payload, b'{"host": "192.0.2.1", "port": 443}')
        await control.drain()
        control.write(b"hello")
        await control.drain()
        sent = await self.tunnel.wait_for_type(TCP_DATA)
        self.assertEqual(sent.payload, b"hello")
        await node_agent.handle_frame(
            self.tunnel, self.lock, self.streams, self.flows,
            Frame(TCP_DATA, 0, "test-node", sent.stream_id, 1, b"world"),
            set(), set(), self.open_waiters, self.open_errors,
        )
        self.assertEqual(await asyncio.wait_for(reader.readexactly(5), 2), b"world")
        control.close()
        await control.wait_closed()

    async def test_inbound_tcp_uses_node_specific_allowlist(self):
        async def echo(reader, writer):
            data = await reader.read(32)
            writer.write(data.upper())
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        service = await asyncio.start_server(echo, "127.0.0.1", 0)
        port = service.sockets[0].getsockname()[1]
        try:
            frame = Frame(
                INGRESS_TCP_OPEN, 0, "test-node", 0x80000001, 0,
                f'{{"host":"127.0.0.1","port":{port}}}'.encode(),
            )
            await node_agent.handle_frame(
                self.tunnel, self.lock, self.streams, self.flows, frame,
                {("127.0.0.1", port)}, set(), self.open_waiters, self.open_errors,
            )
            opened = await self.tunnel.wait_for_type(TCP_OPENED)
            self.assertEqual(opened.stream_id, frame.stream_id)
            await node_agent.handle_frame(
                self.tunnel, self.lock, self.streams, self.flows,
                Frame(TCP_DATA, 0, "test-node", frame.stream_id, 0, b"hello"),
                set(), set(), self.open_waiters, self.open_errors,
            )
            reply = await self.tunnel.wait_for_type(TCP_DATA)
            self.assertEqual(reply.payload, b"HELLO")
        finally:
            service.close()
            await service.wait_closed()

    async def test_inbound_udp_uses_node_specific_allowlist(self):
        class Echo(asyncio.DatagramProtocol):
            def connection_made(self, transport):
                self.transport = transport

            def datagram_received(self, data, addr):
                self.transport.sendto(data.upper(), addr)

        service, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            Echo, local_addr=("127.0.0.1", 0)
        )
        port = service.get_extra_info("sockname")[1]
        stream_id = 0x80000003
        try:
            await node_agent.handle_frame(
                self.tunnel, self.lock, self.streams, self.flows,
                Frame(
                    INGRESS_UDP_OPEN, 0, "test-node", stream_id, 0,
                    f'{{"host":"127.0.0.1","port":{port}}}'.encode(),
                ),
                set(), {("127.0.0.1", port)}, self.open_waiters, self.open_errors,
            )
            opened = await self.tunnel.wait_for_type(UDP_OPENED)
            self.assertEqual(opened.stream_id, stream_id)
            await node_agent.handle_frame(
                self.tunnel, self.lock, self.streams, self.flows,
                Frame(UDP_DATA, 0, "test-node", stream_id, 0, b"hello"),
                set(), set(), self.open_waiters, self.open_errors,
            )
            reply = await self.tunnel.wait_for_type(UDP_DATA)
            self.assertEqual(reply.payload, b"HELLO")
        finally:
            service.close()


if __name__ == "__main__":
    unittest.main()
