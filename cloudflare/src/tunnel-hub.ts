import { DurableObject } from "cloudflare:workers";

interface SessionInfo {
  nodeId: string;
  connectedAt: number;
  lastSeenAt: number;
}

interface ClientMessage {
  type?: unknown;
  ts?: unknown;
}

export class TunnelHub extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
      }
      const nodeId = request.headers.get("x-node-id") ?? "";
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) {
        return Response.json({ error: "invalid_node_id" }, { status: 400 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const now = Date.now();
      server.serializeAttachment({ nodeId, connectedAt: now, lastSeenAt: now } satisfies SessionInfo);
      this.ctx.acceptWebSocket(server, [nodeId]);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/nodes" && request.method === "GET") {
      const latestByNode = new Map<string, SessionInfo>();
      for (const socket of this.ctx.getWebSockets()) {
        try {
          const session = socket.deserializeAttachment() as SessionInfo | null;
          if (!session?.nodeId) continue;
          const previous = latestByNode.get(session.nodeId);
          if (!previous || session.lastSeenAt > previous.lastSeenAt) {
            latestByNode.set(session.nodeId, session);
          }
        } catch {
          // Ignore an invalid attachment rather than breaking the health endpoint.
        }
      }
      return Response.json({ nodes: Array.from(latestByNode.values()).map((session) => ({
        node_id: session.nodeId,
        connected: true,
        connected_at: new Date(session.connectedAt).toISOString(),
        last_seen_at: new Date(session.lastSeenAt).toISOString(),
      })) });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 4096) {
      socket.send(JSON.stringify({ type: "ERROR", code: "invalid_message" }));
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      socket.send(JSON.stringify({ type: "ERROR", code: "invalid_json" }));
      return;
    }

    if (parsed.type !== "PING") {
      socket.send(JSON.stringify({ type: "ERROR", code: "unsupported_message" }));
      return;
    }

    const session = socket.deserializeAttachment() as SessionInfo | null;
    if (!session?.nodeId) {
      socket.close(1011, "missing session");
      return;
    }
    session.lastSeenAt = Date.now();
    socket.serializeAttachment(session);
    socket.send(JSON.stringify({ type: "PONG", ts: parsed.ts ?? null, server_ts: session.lastSeenAt }));
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "websocket error");
  }
}
