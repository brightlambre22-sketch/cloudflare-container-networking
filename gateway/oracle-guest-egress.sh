#!/bin/sh
set -eu
# Optional policy for an actual dedicated Linux guest bridge (not applied automatically).
# Usage: GUEST_BRIDGE=br-guests GUEST_CIDR=10.240.0.0/16 GUEST_GATEWAY=10.240.0.1 ./oracle-guest-egress.sh
if [ "$(id -u)" -ne 0 ]; then echo "Run as root." >&2; exit 1; fi
: "${GUEST_BRIDGE:?Set GUEST_BRIDGE}"
: "${GUEST_CIDR:?Set GUEST_CIDR}"
: "${GUEST_GATEWAY:?Set GUEST_GATEWAY}"
command -v iptables >/dev/null 2>&1 || { echo "iptables is required." >&2; exit 1; }
ip link show "$GUEST_BRIDGE" >/dev/null 2>&1 || { echo "Bridge not found: $GUEST_BRIDGE" >&2; exit 1; }
CHAIN="VQ_GUEST_EGRESS"
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
# Anti-spoofing and guest-to-guest isolation.
iptables -A "$CHAIN" ! -s "$GUEST_CIDR" -j DROP
iptables -A "$CHAIN" -d "$GUEST_CIDR" ! -d "$GUEST_GATEWAY" -j DROP
# Metadata/link-local endpoints, including 169.254.169.254.
iptables -A "$CHAIN" -d 169.254.0.0/16 -j DROP
# Only DHCP/DNS may reach the explicitly configured gateway.
iptables -A "$CHAIN" -d "$GUEST_GATEWAY" -p udp -m multiport --dports 53,67,68 -j ACCEPT
iptables -A "$CHAIN" -d "$GUEST_GATEWAY" -p tcp --dport 53 -j ACCEPT
# Block private host networks and carrier-grade NAT.
iptables -A "$CHAIN" -d 10.0.0.0/8 -j DROP
iptables -A "$CHAIN" -d 172.16.0.0/12 -j DROP
iptables -A "$CHAIN" -d 192.168.0.0/16 -j DROP
iptables -A "$CHAIN" -d 100.64.0.0/10 -j DROP
iptables -A "$CHAIN" -d 127.0.0.0/8 -j DROP
# Public guest egress is limited to HTTP(S); everything else fails closed.
iptables -A "$CHAIN" -p tcp -m multiport --dports 80,443 -j ACCEPT
iptables -A "$CHAIN" -j DROP
iptables -C FORWARD -i "$GUEST_BRIDGE" -j "$CHAIN" 2>/dev/null || iptables -I FORWARD 1 -i "$GUEST_BRIDGE" -j "$CHAIN"
echo "Guest bridge isolation installed for $GUEST_CIDR on $GUEST_BRIDGE."
