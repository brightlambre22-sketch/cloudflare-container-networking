#!/usr/bin/env python3
"""FineProxy SOCKS5 UDP capability probe.

Diagnostic only. It does not modify the production node.

Environment:
  FINEPROXY_HOST       proxy hostname/IP
  FINEPROXY_PORT       proxy TCP port
  FINEPROXY_USER       optional SOCKS5 username
  FINEPROXY_PASSWORD   optional SOCKS5 password

Optional:
  UDP_TARGET_HOST      destination for the outbound UDP probe (default: 1.1.1.1)
  UDP_TARGET_PORT      destination port (default: 53)
  UDP_TIMEOUT          seconds (default: 5)

The probe establishes SOCKS5 UDP ASSOCIATE, prints the relay endpoint,
sends a DNS query, and then listens briefly for independently originated
datagrams. A successful SOCKS5 UDP association does NOT prove unsolicited
inbound UDP forwarding.
"""

import os
import random
import socket
import struct
import sys
import time


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        raise SystemExit(f"missing required environment variable: {name}")
    return value


def recv_exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise RuntimeError("proxy closed the TCP control connection")
        data += chunk
    return data


def socks5_request(sock, host, port):
    request = (
        b"\x05\x03\x00\x03"
        + bytes([len(host)])
        + host.encode("idna")
        + struct.pack("!H", port)
    )
    sock.sendall(request)

    head = recv_exact(sock, 4)
    version, reply, _reserved, atyp = head
    if version != 5:
        raise RuntimeError(f"unexpected SOCKS version: {version}")
    if reply != 0:
        names = {
            1: "general_failure",
            2: "not_allowed",
            3: "network_unreachable",
            4: "host_unreachable",
            5: "connection_refused",
            6: "ttl_expired",
            7: "command_not_supported",
            8: "address_type_not_supported",
        }
        raise RuntimeError(f"UDP ASSOCIATE rejected: {names.get(reply, reply)}")

    if atyp == 1:
        address = socket.inet_ntoa(recv_exact(sock, 4))
    elif atyp == 3:
        length = recv_exact(sock, 1)[0]
        address = recv_exact(sock, length).decode()
    elif atyp == 4:
        address = socket.inet_ntop(socket.AF_INET6, recv_exact(sock, 16))
    else:
        raise RuntimeError(f"unsupported relay address type: {atyp}")

    relay_port = struct.unpack("!H", recv_exact(sock, 2))[0]
    return address, relay_port


def encode_udp_packet(host, port, payload):
    host_bytes = host.encode("idna")
    return (
        b"\x00\x00\x00"
        + bytes([3, len(host_bytes)])
        + host_bytes
        + struct.pack("!H", port)
        + payload
    )


def parse_udp_packet(data):
    if len(data) < 4 or data[0:2] != b"\x00\x00" or data[2] != 0:
        raise ValueError("malformed SOCKS5 UDP packet")

    atyp = data[3]
    offset = 4
    if atyp == 1:
        host = socket.inet_ntoa(data[offset:offset + 4])
        offset += 4
    elif atyp == 3:
        length = data[offset]
        offset += 1
        host = data[offset:offset + length].decode(errors="replace")
        offset += length
    elif atyp == 4:
        host = socket.inet_ntop(socket.AF_INET6, data[offset:offset + 16])
        offset += 16
    else:
        raise ValueError(f"unknown ATYP {atyp}")

    if len(data) < offset + 2:
        raise ValueError("missing UDP port")
    port = struct.unpack("!H", data[offset:offset + 2])[0]
    return host, port, data[offset + 2:]


def build_dns_query():
    txid = random.randrange(0, 65536)
    header = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0)
    question = b"\x07example\x03com\x00" + struct.pack("!HH", 1, 1)
    return txid, header + question


def main():
    proxy_host = env("FINEPROXY_HOST", required=True)
    proxy_port = int(env("FINEPROXY_PORT", required=True))
    username = env("FINEPROXY_USER", "")
    password = env("FINEPROXY_PASSWORD", "")
    target_host = env("UDP_TARGET_HOST", "1.1.1.1")
    target_port = int(env("UDP_TARGET_PORT", "53"))
    timeout = float(env("UDP_TIMEOUT", "5"))

    control = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
    control.settimeout(timeout)
    try:
        methods = [0]
        if username or password:
            methods.append(2)
        control.sendall(bytes([5, len(methods), *methods]))
        version, method = recv_exact(control, 2)
        if version != 5:
            raise RuntimeError(f"unexpected SOCKS version: {version}")
        if method == 0xFF:
            raise RuntimeError("FineProxy rejected all SOCKS5 authentication methods")
        if method == 2:
            user_b = username.encode()
            pass_b = password.encode()
            control.sendall(bytes([1, len(user_b)]) + user_b + bytes([len(pass_b)]) + pass_b)
            auth_version, auth_status = recv_exact(control, 2)
            if auth_version != 1 or auth_status != 0:
                raise RuntimeError("SOCKS5 username/password authentication failed")

        relay_host, relay_port = socks5_request(control, "0.0.0.0", 0)
        print(f"SOCKS5 UDP relay: {relay_host}:{relay_port}", flush=True)

        relay_ip = relay_host
        if relay_host in ("0.0.0.0", "::"):
            relay_ip = socket.gethostbyname(proxy_host)

        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.settimeout(timeout)
        try:
            txid, dns_query = build_dns_query()
            packet = encode_udp_packet(target_host, target_port, dns_query)
            udp.sendto(packet, (relay_ip, relay_port))
            print(f"sent UDP probe through relay to {target_host}:{target_port}", flush=True)

            deadline = time.time() + timeout
            while time.time() < deadline:
                udp.settimeout(max(0.1, deadline - time.time()))
                data, source = udp.recvfrom(65535)
                try:
                    src_host, src_port, payload = parse_udp_packet(data)
                except ValueError:
                    continue
                if len(payload) >= 2 and struct.unpack("!H", payload[:2])[0] == txid:
                    print(
                        f"received UDP reply via relay from {src_host}:{src_port} "
                        f"({len(payload)} bytes)",
                        flush=True,
                    )
                    print("OUTBOUND_UDP=PASS", flush=True)
                    break
            else:
                print("no UDP reply received before timeout", flush=True)
                print("OUTBOUND_UDP=FAIL", flush=True)

            print(
                "INBOUND_UDP_TEST=MANUAL: send a UDP datagram from an independent "
                "internet host to the printed relay endpoint while this control "
                "connection remains open.",
                flush=True,
            )
            print(
                "If an independent datagram arrives, that is evidence of external "
                "ingress to the SOCKS5 relay; it is not yet proof of Mysterium compatibility.",
                flush=True,
            )

            end = time.time() + 20
            while time.time() < end:
                try:
                    data, source = udp.recvfrom(65535)
                    print(f"received relay datagram from {source}: {len(data)} bytes", flush=True)
                except socket.timeout:
                    pass
        finally:
            udp.close()
    finally:
        control.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
