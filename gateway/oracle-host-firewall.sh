#!/bin/sh
set -eu

# Vampirequid Oracle host ingress policy for an outbound-only gateway.
#
# This policy deliberately has NO source-IP SSH exception. The Oracle host
# initiates its authenticated WSS connection to Cloudflare; unsolicited
# inbound connections, including direct public SSH, are denied.
#
# IMPORTANT:
# Apply only after the private Vampirequid administrative path has been
# implemented and tested. Existing SSH sessions may survive the reload, but
# new direct SSH sessions will be blocked. Keep OCI serial-console recovery
# available before applying.

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

command -v firewall-cmd >/dev/null 2>&1 || {
  echo "firewall-cmd is required; this script manages firewalld only." >&2
  exit 1
}

firewall-cmd --state >/dev/null 2>&1 || {
  echo "firewalld is not running. Refusing to replace or bypass the host firewall." >&2
  exit 1
}

# This host currently has one active zone. Refuse ambiguous multi-zone
# configurations rather than silently hardening only one interface.
ACTIVE_ZONES="$(firewall-cmd --get-active-zones)"
ZONE_COUNT="$(printf '%s\n' "$ACTIVE_ZONES" | awk 'NF && $1 !~ /^interfaces:|^sources:/ {n++} END {print n+0}')"
if [ "$ZONE_COUNT" -ne 1 ]; then
  echo "Expected exactly one active firewalld zone; found $ZONE_COUNT. Inspect: firewall-cmd --get-active-zones" >&2
  exit 1
fi

ZONE="$(printf '%s\n' "$ACTIVE_ZONES" | awk 'NF && $1 !~ /^interfaces:|^sources:/ {print $1; exit}')"
[ -n "$ZONE" ] || {
  echo "Could not determine the active firewalld zone." >&2
  exit 1
}

BACKUP="/root/firewalld-backup-$(date +%Y%m%d-%H%M%S)"
cp -a /etc/firewalld "$BACKUP"
echo "Backed up firewalld configuration to $BACKUP"

# Persist a default-drop policy for the active zone. Preserve Oracle's
# DHCPv6 client service and all unrelated zone configuration.
firewall-cmd --permanent --zone="$ZONE" --set-target=DROP
firewall-cmd --permanent --zone="$ZONE" --remove-service=ssh || true

# Remove the unused inbound allowances observed during the host audit.
for PORT in 4449/tcp 4450/tcp 4451/tcp 4053/tcp 8787/tcp 10000-60000/udp; do
  firewall-cmd --permanent --zone="$ZONE" --remove-port="$PORT" || true
done

firewall-cmd --check-config

# Apply the persistent firewalld policy. Established SSH sessions should
# remain tracked, but new direct SSH connections will no longer be admitted.
firewall-cmd --reload

# Remove the temporary VQ iptables-nft chains created by the earlier
# emergency script. firewalld now owns the persistent ingress policy.
if command -v iptables >/dev/null 2>&1 &&
   iptables -S INPUT 2>/dev/null | grep -q -- '-j VQ_ORIGIN_IN'; then
  while iptables -C INPUT -j VQ_ORIGIN_IN 2>/dev/null; do
    iptables -D INPUT -j VQ_ORIGIN_IN
  done
  iptables -F VQ_ORIGIN_IN 2>/dev/null || true
  iptables -X VQ_ORIGIN_IN 2>/dev/null || true
fi

if command -v ip6tables >/dev/null 2>&1 &&
   ip6tables -S INPUT 2>/dev/null | grep -q -- '-j VQ_ORIGIN_IN6'; then
  while ip6tables -C INPUT -j VQ_ORIGIN_IN6 2>/dev/null; do
    ip6tables -D INPUT -j VQ_ORIGIN_IN6
  done
  ip6tables -F VQ_ORIGIN_IN6 2>/dev/null || true
  ip6tables -X VQ_ORIGIN_IN6 2>/dev/null || true
fi

echo
echo "Persistent firewalld ingress policy applied to zone: $ZONE"
echo "Zone target: $(firewall-cmd --zone="$ZONE" --get-target)"
echo "Runtime zone configuration:"
firewall-cmd --zone="$ZONE" --list-all
echo
echo "No direct public SSH exception exists. Do not close your current session"
echo "until private gateway administration and OCI serial-console recovery"
echo "have both been tested. Outbound Cloudflare WSS remains permitted."
