#!/bin/sh
set -eu
# Outbound-only Oracle gateway: no public ingress is required for its WSS tunnel.
# Run from OCI serial console, or set SSH_ALLOW_CIDR to your fixed admin source CIDR.
if [ "$(id -u)" -ne 0 ]; then echo "Run as root." >&2; exit 1; fi
command -v iptables >/dev/null 2>&1 || { echo "iptables is required." >&2; exit 1; }
SSH_ALLOW_CIDR="${SSH_ALLOW_CIDR:-}"
if [ -z "$SSH_ALLOW_CIDR" ] && [ "${CONFIRM_NO_SSH:-}" != "YES" ]; then
  echo "Set SSH_ALLOW_CIDR or CONFIRM_NO_SSH=YES when using OCI console." >&2
  exit 2
fi
CHAIN="VQ_ORIGIN_IN"
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -i lo -j ACCEPT
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
if [ -n "$SSH_ALLOW_CIDR" ]; then
  iptables -A "$CHAIN" -p tcp --dport 22 -s "$SSH_ALLOW_CIDR" -m conntrack --ctstate NEW -j ACCEPT
fi
iptables -A "$CHAIN" -j DROP
iptables -C INPUT -j "$CHAIN" 2>/dev/null || iptables -I INPUT 1 -j "$CHAIN"
echo "New inbound connections are blocked except optional SSH from the trusted CIDR."
echo "Outbound Cloudflare WSS on TCP/443 and established replies remain available."
echo "Validate a second admin session, then persist with your OS firewall manager."
