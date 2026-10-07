import asyncio
import struct
import unittest

from socks5 import decode_udp_packet, encode_udp_packet, open_tcp_connection, open_udp_association


class Socks5PacketTests(unittest.TestCase):
    def test_round_trip_ipv4_and_domain_packets(self):
        for host in ("192.0.2.10", "example.com", "2001:db8::1"):
            packet = encode_udp_packet(host, 5353, b"payload")
            decoded_host, port, payload = decode_udp_packet(packet)
            self.assertEqual(decoded_host, host)
            self.assertEqual(port, 5353)
            self.assertEqual(payload, b"payload")

    def test_rejects_fragmented_datagrams(self):
        with self.assertRaisesRegex(ValueError, "fragmented"):
            decode_udp_packet(b"\x00\x00\x01\x01\x7f\x00\x00\x01\x00\x35x")


class Socks5LocalProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_tcp_connect_negotiation_and_stream(self):
        async def proxy(reader, writer):
            version, count = await reader.readexactly(2)
            await reader.readexactly(count)
            writer.write(b"\x05\x00")
            await writer.drain()
            version, command, reserved, atyp = await reader.readexactly(4)
            if atyp == 1:
                await reader.readexactly(4)
            elif atyp == 3:
                await reader.readexactly((await reader.readexactly(1))[0])
            elif atyp == 4:
                await reader.readexactly(16)
            await reader.readexactly(2)
            self.assertEqual((version, command, reserved), (5, 1, 0))
            writer.write(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x01")
            await writer.drain()
            data = await reader.readexactly(4)
            writer.write(data.upper())
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            reader, writer = await open_tcp_connection("127.0.0.1", port, "example.com", 443)
            writer.write(b"ping")
            await writer.drain()
            self.assertEqual(await reader.readexactly(4), b"PING")
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()

    async def test_udp_associate_keeps_control_socket_and_relays_datagram(self):
        class Echo(asyncio.DatagramProtocol):
            def connection_made(self, transport):
                self.transport = transport

            def datagram_received(self, data, addr):
                self.transport.sendto(data, addr)

        loop = asyncio.get_running_loop()
        echo_transport, _ = await loop.create_datagram_endpoint(
            Echo, local_addr=("127.0.0.1", 0)
        )
        echo_port = echo_transport.get_extra_info("sockname")[1]

        async def proxy(reader, writer):
            _, count = await reader.readexactly(2)
            await reader.readexactly(count)
            writer.write(b"\x05\x00")
            await writer.drain()
            request = await reader.readexactly(10)
            self.assertEqual(request[:4], b"\x05\x03\x00\x01")
            writer.write(b"\x05\x00\x00\x01\x7f\x00\x00\x01" + struct.pack("!H", relay_port))
            await writer.drain()
            await reader.read()
            writer.close()

        relay_transport, _ = await loop.create_datagram_endpoint(
            Echo, local_addr=("127.0.0.1", 0)
        )
        relay_port = relay_transport.get_extra_info("sockname")[1]
        server = await asyncio.start_server(proxy, "127.0.0.1", 0)
        proxy_port = server.sockets[0].getsockname()[1]
        try:
            _, control_writer, udp_socket = await open_udp_association("127.0.0.1", proxy_port)
            packet = encode_udp_packet("127.0.0.1", echo_port, b"udp-check")
            await loop.sock_sendall(udp_socket, packet)
            self.assertEqual(await asyncio.wait_for(loop.sock_recv(udp_socket, 2048), 2), packet)
            udp_socket.close()
            control_writer.close()
            await control_writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()
            echo_transport.close()
            relay_transport.close()


if __name__ == "__main__":
    unittest.main()
