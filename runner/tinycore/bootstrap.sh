#!/bin/sh
set -eu

# Idempotent Tiny Core first-boot bootstrap for the PoC.

PERSIST="/etc/cloudflare-node"
mkdir -p "$PERSIST"

if [ ! -f "$PERSIST/installed" ]; then
  echo "Installing runner prerequisites..."
  # Package installation is image/repository specific.
  # The marker prevents reinstalling on every boot.
  touch "$PERSIST/installed"
fi

IFACE="${NODE_INTERFACE:-eth0}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

"$SCRIPT_DIR/configure-node-ips.sh" "$IFACE"

echo "Tiny Core PoC bootstrap complete."
echo "Persistent state: $PERSIST"
echo "Private node range: 10.240.0.2-10.240.0.101"
echo "Install the Mysterium amd64 package and enable its service next."
