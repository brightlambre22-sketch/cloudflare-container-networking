#!/bin/sh
set -eu

# Install the network-only final-boot gate as Tiny Core's /opt/bootlocal.sh.
# Usage: sudo ./install-persistence.sh [runner-source-directory]
SRC="${1:-/tmp/cloudflare-node}"
BOOT_SRC="$SRC/bootlocal.sh"
DEST="/opt/bootlocal.sh"

[ -f "$BOOT_SRC" ] || {
  echo "bootlocal.sh not found in source directory: $SRC" >&2
  exit 1
}
[ -d /opt ] || { echo "/opt is unavailable" >&2; exit 1; }

cp "$BOOT_SRC" "$DEST"
chmod 755 "$DEST"

# Ensure the boot hook and private node configuration are included in Tiny Core's filetool backup list so this boot hook
# itself and the node's private configuration survive the successful save. Do not
# trigger a backup during install: the boot hook performs it only after checks pass.
mkdir -p /etc/cloudflare-node
chmod 700 /etc/cloudflare-node
if [ ! -f /opt/.filetool.lst ]; then
  : > /opt/.filetool.lst
fi
for path in opt etc/cloudflare-node; do
  if ! grep -qx "$path" /opt/.filetool.lst; then
    printf '%s\n' "$path" >> /opt/.filetool.lst
  fi
done
if [ -f /etc/cloudflare-node/node.env ]; then
  chmod 600 /etc/cloudflare-node/node.env
fi

echo "Installed network-only final-boot gate at $DEST"
echo "Persistent node configuration directory: /etc/cloudflare-node"
echo "Place node.env there with mode 600; it is included in the Tiny Core backup."
echo "On the next boot it will wait for a default route, verify HTTPS/TLS,"
echo "and run filetool.sh -b only if those checks pass."
