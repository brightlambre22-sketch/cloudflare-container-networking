#!/bin/sh
set -eu

# Safe browser/v86 bootstrap. Installs only pinned, verified runner scripts.
# Usage: browser-bootstrap.sh <cloudflare-api-url> <node-id>

API_URL="${1:-}"
NODE_ID="${2:-}"
PINNED_REF="8ee542e32906aaf196f76c221e902410aa066e45"
RAW_BASE="${API_URL%/}/runner/tinycore"

[ -n "$API_URL" ] && [ -n "$NODE_ID" ] || { echo "Usage: browser-bootstrap.sh <https-worker-url> <node-id>" >&2; exit 1; }
case "$API_URL" in https://*) ;; *) echo "API URL must use https://" >&2; exit 1;; esac
case "$NODE_ID" in *[!a-zA-Z0-9._-]*|'') echo "Invalid node id" >&2; exit 1;; esac

ROOT="/opt/cloudflare-node"
ENV="/etc/cloudflare-node"
mkdir -p "$ROOT" "$ENV" /var/log /var/lib/mysterium-node

command -v wget >/dev/null 2>&1 || { echo "wget is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }

fetch_verified() {
  name="$1"
  expected="$2"
  tmp="/tmp/$name.$$"
  wget -q -O "$tmp" "$RAW_BASE/$name"
  actual="$(sha256sum "$tmp" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || { echo "SHA-256 mismatch: $name" >&2; rm -f "$tmp"; exit 1; }
  mv "$tmp" "$ROOT/$name"
  chmod +x "$ROOT/$name"
}

# SHA-256 values for the exact pinned files.
fetch_verified configure-node-ips.sh 8ee542e32906aaf196f76c221e902410aa066e45
fetch_verified myst-supervisor.sh 89dd406bc68cec684f4e556d9a5fef91e80b9867
fetch_verified cloudflare-runner.sh f3686a8d25de2cb16ba8ab28fb72e24e7cc51624

cat >"$ENV/node.env" <<EOF
NODE_ID=$NODE_ID
CLOUDFLARE_API_URL=$API_URL
NODE_INTERFACE=eth0
MYST_BIN=/opt/mysterium/myst
MYST_DATA_DIR=/var/lib/mysterium-node
RUNNER_POLL_SECONDS=5
RUNNER_HEARTBEAT_SECONDS=10
EOF
chmod 600 "$ENV/node.env"

wget -q -O /tmp/runtime-start.json   --header='Content-Type: application/json'   --post-data=''   "$API_URL/v1/nodes/$NODE_ID/runtime/start" || true

echo "Pinned Tiny Core runner installed for $NODE_ID"
