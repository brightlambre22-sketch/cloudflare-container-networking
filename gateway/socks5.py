"""Small RFC 1928/1929 helpers for SOCKS5 UDP ASSOCIATE."""

import ipaddress
import struct


def encode_udp_packet(host: str, port: int, payload: bytes) -> bytes:
    if not 1 <= port <= 65535:
        raise ValueError("invalid_destination_port")
    try:
        address = ipaddress.ip_address(host)
        atyp = 1 if address.version == 4 else 4
        encoded_host = address.packed
    except ValueError:
        encoded_host = host.encode("idna")
        if not 1 <= len(encoded_host) <= 255:
            raise ValueError("invalid_destination_host")
        atyp = 3
        encoded_host = bytes((len(encoded_host),)) + encoded_host
    return b"\x00\x00\x00" + bytes((atyp,)) + encoded_host + struct.pack("!H", port) + payload


def decode_udp_packet(packet: bytes) -> tuple[str, int, bytes]:
    if len(packet) < 7 or packet[:2] != b"\x00\x00":
        raise ValueError("invalid_socks5_udp_header")
    if packet[2] != 0:
        raise ValueError("fragmented_socks5_udp_not_supported")
    atyp = packet[3]
    offset = 4
    if atyp == 1:
        width = 4
        if len(packet) < offset + width + 2:
            raise ValueError("truncated_socks5_udp_packet")
        host = str(ipaddress.ip_address(packet[offset:offset + width]))
        offset += width
    elif atyp == 4:
        width = 16
        if len(packet) < offset + width + 2:
            raise ValueError("truncated_socks5_udp_packet")
        host = str(ipaddress.ip_address(packet[offset:offset + width]))
        offset += width
    elif atyp == 3:
        if len(packet) <= offset:
            raise ValueError("truncated_socks5_udp_packet")
        width = packet[offset]
        offset += 1
        if width == 0 or len(packet) < offset + width + 2:
            raise ValueError("truncated_socks5_udp_packet")
        try:
            host = packet[offset:offset + width].decode("idna")
        except UnicodeError as error:
            raise ValueError("invalid_socks5_udp_host") from error
        offset += width
    else:
        raise ValueError("unsupported_socks5_address_type")
    port = struct.unpack_from("!H", packet, offset)[0]
    if port == 0:
        raise ValueError("invalid_destination_port")
    return host, port, packet[offset + 2:]


async def open_udp_association(host: str, port: int, username: str = "",
                               password: str = ""):
    """Negotiate UDP ASSOCIATE; keep the TCP control socket open."""
    import asyncio
    import socket

    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=10)
    try:
        methods = b"\x00\x02" if username or password else b"\x00"
        writer.write(b"\x05" + bytes((len(methods),)) + methods)
        await writer.drain()
        version, method = await asyncio.wait_for(reader.readexactly(2), timeout=10)
        if version != 5 or method == 0xFF:
            raise ConnectionError("socks5_authentication_method_rejected")
        if method == 2:
            user = username.encode("utf-8")
            secret = password.encode("utf-8")
            if not user or len(user) > 255 or len(secret) > 255:
                raise ValueError("invalid_socks5_credentials")
            writer.write(b"\x01" + bytes((len(user),)) + user + bytes((len(secret),)) + secret)
            await writer.drain()
            auth_version, status = await asyncio.wait_for(reader.readexactly(2), timeout=10)
            if auth_version != 1 or status != 0:
                raise ConnectionError("socks5_authentication_failed")
        elif method != 0:
            raise ConnectionError("unsupported_socks5_authentication_method")

        writer.write(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
        await writer.drain()
        head = await asyncio.wait_for(reader.readexactly(4), timeout=10)
        version, reply, reserved, atyp = head
        if version != 5 or reply != 0 or reserved != 0:
            raise ConnectionError(f"socks5_udp_associate_failed_{reply}")
        if atyp == 1:
            raw_host = await reader.readexactly(4)
            relay_host = socket.inet_ntop(socket.AF_INET, raw_host)
        elif atyp == 4:
            raw_host = await reader.readexactly(16)
            relay_host = socket.inet_ntop(socket.AF_INET6, raw_host)
        elif atyp == 3:
            length = (await reader.readexactly(1))[0]
            relay_host = (await reader.readexactly(length)).decode("idna")
        else:
            raise ConnectionError("invalid_socks5_udp_relay_address")
        relay_port = struct.unpack("!H", await reader.readexactly(2))[0]
        if relay_port == 0:
            raise ConnectionError("invalid_socks5_udp_relay_port")
        if relay_host in ("0.0.0.0", "::"):
            relay_host = host
        infos = await asyncio.get_running_loop().getaddrinfo(
            relay_host, relay_port, type=socket.SOCK_DGRAM
        )
        family, socktype, proto, _, address = infos[0]
        udp_socket = socket.socket(family, socktype, proto)
        udp_socket.setblocking(False)
        udp_socket.connect(address)
        return reader, writer, udp_socket
    except Exception:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        raise


async def _authenticate(reader, writer, username: str, password: str) -> None:
    methods = b"\x00\x02" if username or password else b"\x00"
    writer.write(b"\x05" + bytes((len(methods),)) + methods)
    await writer.drain()
    version, method = await reader.readexactly(2)
    if version != 5 or method == 0xFF:
        raise ConnectionError("socks5_authentication_method_rejected")
    if method == 2:
        user, secret = username.encode(), password.encode()
        if not user or len(user) > 255 or len(secret) > 255:
            raise ValueError("invalid_socks5_credentials")
        writer.write(b"\x01" + bytes((len(user),)) + user + bytes((len(secret),)) + secret)
        await writer.drain()
        auth_version, status = await reader.readexactly(2)
        if auth_version != 1 or status != 0:
            raise ConnectionError("socks5_authentication_failed")
    elif method != 0:
        raise ConnectionError("unsupported_socks5_authentication_method")


def _address_bytes(host: str) -> bytes:
    import ipaddress

    try:
        address = ipaddress.ip_address(host)
        return bytes((1 if address.version == 4 else 4,)) + address.packed
    except ValueError:
        encoded = host.encode("idna")
        if not 1 <= len(encoded) <= 255:
            raise ValueError("invalid_destination_host")
        return b"\x03" + bytes((len(encoded),)) + encoded


async def open_tcp_connection(proxy_host: str, proxy_port: int, target_host: str,
                              target_port: int, username: str = "", password: str = ""):
    """Open a TCP stream through a SOCKS5 proxy using CONNECT."""
    import asyncio

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(proxy_host, proxy_port), timeout=10
    )
    try:
        await _authenticate(reader, writer, username, password)
        writer.write(b"\x05\x01\x00" + _address_bytes(target_host)
                     + struct.pack("!H", target_port))
        await writer.drain()
        version, reply, reserved, atyp = await asyncio.wait_for(reader.readexactly(4), 10)
        if version != 5 or reserved != 0 or reply != 0:
            raise ConnectionError(f"socks5_connect_failed_{reply}")
        if atyp == 1:
            await reader.readexactly(4)
        elif atyp == 4:
            await reader.readexactly(16)
        elif atyp == 3:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length)
        else:
            raise ConnectionError("invalid_socks5_bound_address")
        await reader.readexactly(2)
        return reader, writer
    except Exception:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        raise
