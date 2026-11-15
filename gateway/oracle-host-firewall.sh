#!/bin/sh
set -eu
# Outbound-only Oracle gateway: no public ingress is required for its WSS tunnel.
# Run from OCI serial console, or set SSH_ALLOW_CIDR to your fixed admin source CIDR.
if [ "$(id -u)" -ne 0 ]; then echo "Run as root." >&2; exit 1; fi
command -v iptables >/dev/null 2>&1 || { echo "iptables is required." >&2; exit 1; }
SSH_ALLOW_CIDR="${SSH_ALLOW_CIDR:-}"
SSH_ALLOW_CIDR6="${SSH_ALLOW_CIDR6:-}"
if [ -z "$SSH_ALLOW_CIDR" ] && [ -z "$SSH_ALLOW_CIDR6" ] && [ "${CONFIRM_NO_SSH:-}" != "YES" ]; then
  echo "Set SSH_ALLOW_CIDR/SSH_ALLOW_CIDR6 or CONFIRM_NO_SSH=YES when using OCI console." >&2
  exit 2
fi
if [ -e /proc/net/if_inet6 ] && ! command -v ip6tables >/dev/null 2>&1; then
  echo "IPv6 is enabled but ip6tables is unavailable." >&2
  exit 1
fi

CHAIN="VQ_ORIGIN_IN"
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -i lo -j ACCEPT
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$CHAIN" -j DROP
if [ -n "$SSH_ALLOW_CIDR" ]; then
  iptables -I "$CHAIN" 3 -p tcp --dport 22 -s "$SSH_ALLOW_CIDR" -m conntrack --ctstate NEW -j ACCEPT
fi
iptables -C INPUT -j "$CHAIN" 2>/dev/null || iptables -I INPUT 1 -j "$CHAIN"

# Apply the same default-deny policy to IPv6 so a public IPv6 address cannot bypass IPv4 rules.
if [ -e /proc/net/if_inet6 ]; then
  command -v ip6tables >/dev/null 2>&1 || { echo "IPv6 is enabled but ip6tables is unavailable." >&2; exit 1; }
  CHAIN6="VQ_ORIGIN_IN6"
  ip6tables -N "$CHAIN6" 2>/dev/null || true
  ip6tables -F "$CHAIN6"
  ip6tables -A "$CHAIN6" -i lo -j ACCEPT
  ip6tables -A "$CHAIN6" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A "$CHAIN6" -j DROP
  if [ -n "$SSH_ALLOW_CIDR6" ]; then
    ip6tables -I "$CHAIN6" 3 -p tcp --dport 22 -s "$SSH_ALLOW_CIDR6" -m conntrack --ctstate NEW -j ACCEPT
  fi
  ip6tables -C INPUT -j "$CHAIN6" 2>/dev/null || ip6tables -I INPUT 1 -j "$CHAIN6"
fi

echo "New inbound IPv4 and IPv6 connections are blocked except SSH from configured trusted CIDRs."
echo "Outbound Cloudflare WSS on TCP/443 and established replies remain available."
echo "Validate a second admin session, then persist with your OS firewall manager."
