#!/bin/sh
set -eu
umask 077

: "${CLOUDFLARE_API_URL:?Set CLOUDFLARE_API_URL}"
: "${ADMIN_ACCESS_KEY:?Set ADMIN_ACCESS_KEY to your Vampirequid admin access key}"

response="$(curl -fsS -X POST \
  -H "Authorization: Bearer ${ADMIN_ACCESS_KEY}" \
  -H "Content-Type: application/json" \
  "${CLOUDFLARE_API_URL}/v1/nodes" \
  -d '{"count":1}')"

node_id="$(printf '%s' "$response" | sed -n 's/.*"node_id":"\([^"]*\)".*/\1/p')"
agent_token="$(printf '%s' "$response" | sed -n 's/.*"agent_token":"\([a-f0-9]*\)".*/\1/p')"
if [ -z "$node_id" ] || [ -z "$agent_token" ]; then
  echo "Node provisioning did not return both node_id and agent_token." >&2
  echo "Response: $response" >&2
  exit 1
fi

cat > .env <<EOF
NODE_ID=$node_id
NODE_AGENT_TOKEN=$agent_token
CLOUDFLARE_API_URL=$CLOUDFLARE_API_URL
RUNNER_HEARTBEAT_SECONDS=${RUNNER_HEARTBEAT_SECONDS:-10}
EOF
chmod 600 .env

echo "Created node: $node_id"
echo "Saved its one-time agent credential to $(pwd)/.env (mode 600)."
echo "Keep .env private and do not commit or share it."
echo "You can now run: docker compose up -d --build"
