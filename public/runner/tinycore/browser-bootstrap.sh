#!/bin/sh
set -eu

# Safe browser/v86 bootstrap. Installs only pinned, verified runner scripts.
# Usage: browser-bootstrap.sh <cloudflare-api-url> <node-id>

API_URL="${1:-}"
NODE_ID="${2:-}"
PINNED_REF="c052da1b750198d96a6b2149191e62c4848fc948"
RAW_BASE="${API_URL%/}/runner/tinycore"
MYST_VERSION="1.38.5"
MYST_URL="https://github.com/mysteriumnetwork/node/releases/download/$MYST_VERSION/myst_linux_amd64.tar.gz"
MYST_SHA256="79b0aa1ca846cfa02ff8a814828a18d9fba739698295054e13cafb6a74907554"

[ -n "$API_URL" ] && [ -n "$NODE_ID" ] || { echo "Usage: browser-bootstrap.sh <https-worker-url> <node-id>" >&2; exit 1; }
case "$API_URL" in https://*) ;; *) echo "API URL must use https://" >&2; exit 1;; esac
case "$NODE_ID" in *[!a-zA-Z0-9._-]*|'') echo "Invalid node id" >&2; exit 1;; esac

ROOT="/opt/cloudflare-node"
ENV="/etc/cloudflare-node"
mkdir -p "$ROOT" "$ENV" /var/log /var/lib/mysterium-node /opt/mysterium

ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH" in
  x86_64|amd64) ;;
  *)
    echo "Unsupported Tiny Core CPU architecture for Mysterium: $ARCH (requires x86_64)" >&2
    exit 1
    ;;
esac

# Fail early if required utilities are unavailable. Tiny Core commonly has
# OpenSSL but may not include the standalone sha256sum utility.
command -v wget >/dev/null 2>&1 || { echo "wget is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v awk >/dev/null 2>&1 || { echo "awk is required" >&2; exit 1; }
command -v find >/dev/null 2>&1 || { echo "find is required" >&2; exit 1; }
command -v head >/dev/null 2>&1 || { echo "head is required" >&2; exit 1; }
command -v cp >/dev/null 2>&1 || { echo "cp is required" >&2; exit 1; }
command -v chmod >/dev/null 2>&1 || { echo "chmod is required" >&2; exit 1; }
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then
  echo "A SHA-256 utility is required (sha256sum or openssl)" >&2
  exit 1
fi

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  fi
}

# The runner scripts expect a real Mysterium executable. Download the pinned
# official Linux amd64 release and verify its SHA-256 before installing it.
if [ ! -x /opt/mysterium/myst ]; then
  echo "Downloading Mysterium $MYST_VERSION..."
  wget -q -O /tmp/myst_linux_amd64.tar.gz "$MYST_URL"
  actual="$(sha256_file /tmp/myst_linux_amd64.tar.gz)"
  [ "$actual" = "$MYST_SHA256" ] || {
    echo "SHA-256 mismatch: Mysterium $MYST_VERSION" >&2
    rm -f /tmp/myst_linux_amd64.tar.gz
    exit 1
  }
  rm -rf /tmp/myst-extract
  mkdir -p /tmp/myst-extract
  tar -xzf /tmp/myst_linux_amd64.tar.gz -C /tmp/myst-extract
  found="$(find /tmp/myst-extract -type f -name myst | head -n 1)"
  [ -n "$found" ] || {
    echo "Mysterium archive did not contain a myst executable" >&2
    rm -f /tmp/myst-extract /tmp/myst_linux_amd64.tar.gz
    exit 1
  }
  cp "$found" /opt/mysterium/myst
  chmod +x /opt/mysterium/myst
  rm -rf /tmp/myst-extract /tmp/myst_linux_amd64.tar.gz
fi

fetch_verified() {
  name="$1"
  expected="$2"
  tmp="/tmp/${name}.${NODE_ID}.tmp"
  wget -q -O "$tmp" "$RAW_BASE/$name"
  actual="$(sha256_file "$tmp")"
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
