#!/bin/sh
set -eu

# Install this as /usr/local/etc/init.d/bootlocal.sh in the Tiny Core image.
# It is intentionally idempotent: every Tiny Core boot restores the same
# configuration and starts the same supervisor/runner.

RUNNER_ROOT="${NODE_RUNNER_ROOT:-/opt/cloudflare-node}"
ENV_FILE="${NODE_ENV_FILE:-/etc/cloudflare-node/node.env}"
LOG_FILE="/var/log/cloudflare-node-boot.log"

mkdir -p "$RUNNER_ROOT" /etc/cloudflare-node /var/lib/mysterium-node /var/log /var/run

# Tiny Core restores packages/extensions before bootlocal. Networking can still
# take a moment, so wait for an interface and a usable default route.
IFACE="${NODE_INTERFACE:-eth0}"
for _ in $(seq 1 30); do
  if ip link show "$IFACE" >/dev/null 2>&1 && ip link show "$IFACE" | grep -q 'UP'; then
    break
  fi
  sleep 1
done

# Load persistent node settings after the base system is ready.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  echo "Missing $ENV_FILE" >>"$LOG_FILE"
  exit 1
fi

# Wait for routing/DNS before starting outbound control traffic.
for _ in $(seq 1 60); do
  if ip route | grep -q '^default ' && curl -fsS --max-time 3 https://example.com >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Restore the node's assigned private address range.
"$RUNNER_ROOT/configure-node-ips.sh" "$IFACE" >>"$LOG_FILE" 2>&1

if [ ! -x "$MYST_BIN" ]; then
  echo "Missing executable $MYST_BIN" >>"$LOG_FILE"
  exit 1
fi

# Start exactly one supervisor and exactly one control runner.
if ! pgrep -f "$RUNNER_ROOT/myst-supervisor.sh" >/dev/null 2>&1; then
  nohup "$RUNNER_ROOT/myst-supervisor.sh" >>"$LOG_FILE" 2>&1 &
fi

if ! pgrep -f "$RUNNER_ROOT/cloudflare-runner.sh" >/dev/null 2>&1; then
  nohup "$RUNNER_ROOT/cloudflare-runner.sh" >>"$LOG_FILE" 2>&1 &
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Tiny Core node startup complete: $NODE_ID" >>"$LOG_FILE"
