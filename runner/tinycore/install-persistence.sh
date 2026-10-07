#!/bin/sh
set -eu

# Run once inside the Tiny Core guest after copying this runner directory.
# It creates the persistent layout and installs the boot hook.
SRC="${1:-/tmp/cloudflare-node}"
DEST="/opt/cloudflare-node"
ENV_SRC="${2:-$SRC/node.env}"

[ -d "$SRC" ] || { echo "Runner source not found: $SRC" >&2; exit 1; }
[ -f "$ENV_SRC" ] || { echo "node.env not found: $ENV_SRC" >&2; exit 1; }

mkdir -p "$DEST" /etc/cloudflare-node /var/lib/mysterium-node /var/log /var/run
cp "$SRC/configure-node-ips.sh" "$DEST/"
cp "$SRC/myst-supervisor.sh" "$DEST/"
cp "$SRC/cloudflare-runner.sh" "$DEST/"
cp "$SRC/bootlocal.sh" /usr/local/etc/init.d/bootlocal.sh
cp "$ENV_SRC" /etc/cloudflare-node/node.env

chmod +x "$DEST/"*.sh /usr/local/etc/init.d/bootlocal.sh
chmod 600 /etc/cloudflare-node/node.env

echo "Persistent runner installed."
echo "Back up Tiny Core persistence now with: sudo filetool.sh -b"
