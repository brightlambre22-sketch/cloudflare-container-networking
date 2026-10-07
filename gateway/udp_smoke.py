"""Send one caller-supplied UDP packet through the node's local SOCKS5 relay."""

import asyncio
import socket
import sys

from socks5 import decode_udp_packet, encode_udp_packet


async def read_bound_address(reader):
    version, reply, reserved, atyp = await reader.readexactly(4)
    if version != 5 or reply != 0 or reserved != 0:
        raise ConnectionError(f"local_socks5_udp_associate_failed_{reply}")
    if atyp == 1:
        host = socket.inet_ntop(socket.AF_INET, await reader.readexactly(4))
    elif atyp == 4:
        host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
    elif atyp == 3:
        size = (await reader.readexactly(1))[0]
        host = (await reader.readexactly(size)).decode("idna")
    else:
        raise ConnectionError("invalid_local_socks5_relay_address")
    return host, int.from_bytes(await reader.readexactly(2), "big")


async def main(host: str, port: int, payload: bytes) -> None:
    reader, control = await asyncio.open_connection("127.0.0.1", 1080)
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.setblocking(False)
    try:
        control.write(b"\x05\x01\x00")
        await control.drain()
        if await reader.readexactly(2) != b"\x05\x00":
            raise ConnectionError("local_socks5_no_auth_rejected")
        control.write(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
        await control.drain()
        relay_host, relay_port = await read_bound_address(reader)
        udp.bind(("127.0.0.1", 0))
        packet = encode_udp_packet(host, port, payload)
        await asyncio.get_running_loop().sock_sendto(udp, packet, (relay_host, relay_port))
        response, _ = await asyncio.wait_for(
            asyncio.get_running_loop().sock_recvfrom(udp, 65535), timeout=10
        )
        response_host, response_port, response_payload = decode_udp_packet(response)
        print({
            "status": "passed",
            "destination": f"{response_host}:{response_port}",
            "response_bytes": len(response_payload),
            "transport": "node SOCKS5 UDP -> WSS -> FineProxy SOCKS5 UDP",
        })
    finally:
        udp.close()
        control.close()
        await control.wait_closed()


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: python udp_smoke.py <destination-host> <port> <payload-hex>")
    asyncio.run(main(sys.argv[1], int(sys.argv[2]), bytes.fromhex(sys.argv[3])))
