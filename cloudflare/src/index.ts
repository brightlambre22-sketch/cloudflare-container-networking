import { TunnelHub } from "./tunnel-hub";
import { NodeRegistry } from "./node-registry";
import { NodeRuntime } from "./node-runtime";

export { TunnelHub, NodeRegistry, NodeRuntime };

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  NODE_REGISTRY: DurableObjectNamespace<NodeRegistry>;
  NODE_RUNTIME: DurableObjectNamespace<NodeRuntime>;
  TUNNEL_TOKEN: string;
  CLIENT_TOKEN: string;
  ADMIN_TOKEN: string;
}

function authorized(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected || !header.startsWith("Bearer ")) return false;
  const value = header.slice(7);
  if (value.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < value.length; i += 1) difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
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
      return json({ status: "ok", service: "cloudflare-container-networking", virtual_nodes: "control-plane" });
    }

    if (url.pathname === "/tunnel") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_upgrade_required" }, 426);
      const role = request.headers.get("x-tunnel-role");
      const nodeId = request.headers.get("x-node-id") ?? "";
      const expected = role === "gateway" ? env.TUNNEL_TOKEN : role === "client" ? env.CLIENT_TOKEN : undefined;
      if (!authorized(request.headers.get("authorization"), expected)) return json({ error: "unauthorized" }, 401);
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) return json({ error: "invalid_node_id" }, 400);
      const hub = env.TUNNEL_HUB.get(env.TUNNEL_HUB.idFromName("global"));
      return hub.fetch(request);
    }

    if (url.pathname === "/v1/nodes") {
      if (!authorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));

      if (request.method === "GET") {
        return registry.fetch("https://node-registry.internal/list");
      }

      if (request.method === "POST") {
        return registry.fetch(new Request("https://node-registry.internal/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: await request.text(),
        }));
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    if (url.pathname.startsWith("/v1/nodes/") && url.pathname.endsWith("/runtime/start") && request.method === "POST") {
      if (!authorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const nodeId = url.pathname.slice("/v1/nodes/".length, -"/runtime/start".length).replace(/\/$/, "");
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) return json({ error: "invalid_node_id" }, 400);
      const runtime = env.NODE_RUNTIME.get(env.NODE_RUNTIME.idFromName(nodeId));
      return runtime.fetch("https://node-runtime.internal/start", { method: "POST" });
    }

    if (url.pathname.startsWith("/v1/nodes/") && url.pathname.endsWith("/runtime/stop") && request.method === "POST") {
      if (!authorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const nodeId = url.pathname.slice("/v1/nodes/".length, -"/runtime/stop".length).replace(/\/$/, "");
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) return json({ error: "invalid_node_id" }, 400);
      const runtime = env.NODE_RUNTIME.get(env.NODE_RUNTIME.idFromName(nodeId));
      return runtime.fetch("https://node-runtime.internal/stop", { method: "POST" });
    }

    if (url.pathname.startsWith("/v1/nodes/") && url.pathname.endsWith("/runtime") && request.method === "GET") {
      if (!authorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const nodeId = url.pathname.slice("/v1/nodes/".length, -"/runtime".length).replace(/\/$/, "");
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) return json({ error: "invalid_node_id" }, 400);
      const runtime = env.NODE_RUNTIME.get(env.NODE_RUNTIME.idFromName(nodeId));
      return runtime.fetch("https://node-runtime.internal/status");
    }

    if (url.pathname.startsWith("/v1/nodes/") && url.pathname.endsWith("/runtime/probe") && request.method === "GET") {
      if (!authorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const nodeId = url.pathname.slice("/v1/nodes/".length, -"/runtime/probe".length).replace(/\/$/, "");
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) return json({ error: "invalid_node_id" }, 400);
      const runtime = env.NODE_RUNTIME.get(env.NODE_RUNTIME.idFromName(nodeId));
      return runtime.fetch("https://node-runtime.internal/probe");
    }

    if (url.pathname.startsWith("/v1/nodes/")) {
      if (!authorized(request.headers.get("authorization"), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      const nodeId = url.pathname.slice("/v1/nodes/".length);
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));
      return registry.fetch(new Request(`https://node-registry.internal/node/${encodeURIComponent(nodeId)}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "PATCH" ? await request.text() : undefined,
      }));
    }

    return json({ error: "not_found" }, 404);
  },
};
