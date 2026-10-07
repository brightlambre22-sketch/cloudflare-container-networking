import { TunnelHub } from "./tunnel-hub";

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  TUNNEL_TOKEN: string;
  ADMIN_TOKEN: string;
}

function equalSecret(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const prefix = "Bearer ";
  if (!actual.startsWith(prefix)) return false;
  const value = actual.slice(prefix.length);
  if (value.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < value.length; i += 1) {
    difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return json({ status: "ok", service: "cloudflare-container-networking" });
    }

    if (url.pathname === "/tunnel") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }
      if (!equalSecret(request.headers.get("authorization"), env.TUNNEL_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
      const nodeId = request.headers.get("x-node-id") ?? "";
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) {
        return json({ error: "invalid_node_id" }, 400);
      }
      const hub = env.TUNNEL_HUB.get(env.TUNNEL_HUB.idFromName("global"));
      const internalRequest = new Request("https://tunnel-hub.internal/connect", request);
      internalRequest.headers.set("x-node-id", nodeId);
      return hub.fetch(internalRequest);
    }

    if (url.pathname === "/v1/nodes") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (!equalSecret(request.headers.get("authorization"), env.ADMIN_TOKEN)) {
        return json({ error: "unauthorized" }, 401);
      }
      const hub = env.TUNNEL_HUB.get(env.TUNNEL_HUB.idFromName("global"));
      return hub.fetch("https://tunnel-hub.internal/nodes");
    }

    return json({ error: "not_found" }, 404);
  },
};
