import asyncio
import json
import os
import random
import sys
import time

import websockets

TUNNEL_URL = os.environ.get("TUNNEL_URL", "")
TUNNEL_TOKEN = os.environ.get("TUNNEL_TOKEN", "")
NODE_ID = os.environ.get("NODE_ID", "oracle-gateway")
HEARTBEAT_SECONDS = 25


def emit(event: str, **fields: object) -> None:
    record = {"ts": time.time(), "component": "gateway-client", "event": event, **fields}
    print(json.dumps(record, separators=(",", ":")), flush=True)


async def heartbeat(socket: websockets.WebSocketClientProtocol) -> None:
    while True:
        await socket.send(json.dumps({"type": "PING", "ts": time.time()}))
        await asyncio.sleep(HEARTBEAT_SECONDS)


async def run_connection() -> None:
    headers = {"Authorization": f"Bearer {TUNNEL_TOKEN}", "X-Node-ID": NODE_ID}
    async with websockets.connect(
        TUNNEL_URL,
        extra_headers=headers,
        ping_interval=20,
        open_timeout=15,
        close_timeout=5,
        max_size=4096,
    ) as socket:
        emit("connected", node_id=NODE_ID)
        task = asyncio.create_task(heartbeat(socket))
        try:
            async for message in socket:
                if not isinstance(message, str):
                    emit("unexpected_binary_message")
                    continue
                try:
                    parsed = json.loads(message)
                except json.JSONDecodeError:
                    emit("invalid_server_message")
                    continue
                if parsed.get("type") == "PONG":
                    emit("pong", node_id=NODE_ID, server_ts=parsed.get("server_ts"))
                else:
                    emit("server_message", message_type=parsed.get("type", "unknown"))
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        emit("disconnected", node_id=NODE_ID)


async def main() -> None:
    if not TUNNEL_URL.startswith("wss://") or not TUNNEL_TOKEN:
        emit("configuration_error", required=["TUNNEL_URL (wss://...)", "TUNNEL_TOKEN"])
        raise SystemExit(2)
    delay = 1.0
    while True:
        try:
            await run_connection()
            delay = 1.0
        except asyncio.CancelledError:
            raise
        except Exception as error:
            emit("connection_failed", node_id=NODE_ID, error_type=type(error).__name__)
        wait = min(30.0, delay) * random.uniform(0.8, 1.2)
        emit("reconnecting", delay_seconds=round(wait, 2))
        await asyncio.sleep(wait)
        delay = min(30.0, delay * 2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
