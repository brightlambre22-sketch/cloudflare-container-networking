#!/bin/sh
set -eu

# Safe browser/v86 bootstrap. Installs only pinned, verified runner scripts.
# Usage: browser-bootstrap.sh <cloudflare-api-url> <node-id>

API_URL="${1:-}"
NODE_ID="${2:-}"
PINNED_REF="c052da1b750198d96a6b2149191e62c4848fc948"
RAW_BASE="https://raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking/$PINNED_REF/runner/tinycore"

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
fetch_verified configure-node-ips.sh 517a07914d213d7c1e5b7b77b5fe10a3bf8f996f1600eaad515f82374429f5d4
fetch_verified myst-supervisor.sh 717c3100ca11e525912cd422701174d0cad9cf7db5fc5e92d16cf2a5f67db56a
fetch_verified cloudflare-runner.sh 09fd7c7d4a4b91e31b85420c840172d640e83e674b6f3236615ec5bfe247b6d9

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
