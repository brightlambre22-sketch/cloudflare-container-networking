#!/bin/sh
set -eu

# Tiny Core control-plane runner.
# Polls the existing Worker runtime API and reconciles the local Mysterium process.

API_URL="${CLOUDFLARE_API_URL:?Set CLOUDFLARE_API_URL, e.g. https://your-worker.workers.dev}"
NODE_ID="${NODE_ID:?Set NODE_ID}"
MYST_BIN="${MYST_BIN:-/opt/mysterium/myst}"
DATA_DIR="${MYST_DATA_DIR:-/var/lib/mysterium-node}"
LOG_FILE="${MYST_LOG_FILE:-/var/log/mysterium-node.log}"
POLL_SECONDS="${RUNNER_POLL_SECONDS:-5}"
PID_FILE="${MYST_PID_FILE:-/var/run/mysterium-node.pid}"

api() {
  curl -fsS "${API_URL}/v1/nodes/${NODE_ID}/runtime"
}

heartbeat() {
  curl -fsS -X POST "${API_URL}/v1/nodes/${NODE_ID}/runtime/heartbeat" >/dev/null 2>&1 || true
}

patch_node() {
  status="$1"
  error="${2:-}"
  payload="{\"status\":\"$status\",\"runtime\":\"external-gateway\",\"error\":${error:+\"$error\"}${error:-null}}"
  curl -fsS -X PATCH     -H "content-type: application/json"     --data "$payload"     "${API_URL}/v1/nodes/${NODE_ID}" >/dev/null || true
}

running() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_myst() {
  mkdir -p "$DATA_DIR" "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  if running; then return 0; fi

  "$MYST_BIN" service --agreed-terms-and-conditions \
    --data-dir="$DATA_DIR" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 2

  if running; then
    patch_node online
  else
    patch_node error "mysterium_process_failed_to_start"
    return 1
  fi
}

stop_myst() {
  if running; then
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$PID_FILE"
  patch_node offline
}

while :; do
  heartbeat
  desired="$(api | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n 1 || true)"

  case "$desired" in
    running|starting)
      start_myst || true
      ;;
    stopped)
      stop_myst
      ;;
    error)
      patch_node error "cloudflare_requested_error_state"
      ;;
    *)
      # Registry/runtime may not exist yet; retry without killing the local node.
      ;;
  esac

  sleep "$POLL_SECONDS"
done
