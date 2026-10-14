import { connect } from "cloudflare:sockets";
import { ADMIN_ACCESS_CODE } from "./auth-codes";
import { TunnelHub } from "./tunnel-hub";
import { NodeRegistry } from "./node-registry";
import { NodeRuntime } from "./node-runtime";
export { TunnelHub, NodeRegistry, NodeRuntime };

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  NODE_REGISTRY: DurableObjectNamespace<NodeRegistry>;
  NODE_RUNTIME: DurableObjectNamespace<NodeRuntime>;
  VM_SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
  TUNNEL_TOKEN: string;
  CLIENT_TOKEN: string;
}

function authorized(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected || !header.startsWith("Bearer ")) return false;
  const value = header.slice(7);
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function validNodeId(nodeId: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(nodeId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/admin/access") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      let body: { code?: unknown };
      try { body = (await request.json()) as { code?: unknown }; }
      catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body.code !== "string" || body.code !== ADMIN_ACCESS_CODE) return json({ error: "invalid_admin_code" }, 401);
      return json({ ok: true });
    }

    const snapshotMatch = url.pathname.match(/^\/api\/vm-snapshots\/([a-z0-9._-]{1,64})$/i);
    if (snapshotMatch) {
      const identity = snapshotMatch[1].toLowerCase();
      const isAdmin = identity === "admin-user-a" || identity === "admin-user-b";
      if (isAdmin && request.headers.get("x-admin-code") !== ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);
      if (!["GET", "PUT", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
      const key = `vm-snapshots/${identity}.bin`;
      if (request.method === "GET") {
        const object = await env.VM_SNAPSHOTS.get(key);
        if (!object) return json({ error: "snapshot_not_found" }, 404);
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("content-type", "application/octet-stream");
        headers.set("cache-control", "no-store");
        headers.set("x-snapshot-saved-at", object.customMetadata?.savedAt ?? object.uploaded.toISOString());
        return new Response(object.body, { headers });
      }
      if (request.method === "PUT") {
        if (!request.body) return json({ error: "empty_snapshot" }, 400);
        const savedAt = new Date().toISOString();
        await env.VM_SNAPSHOTS.put(key, request.body, {
          httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { savedAt },
        });
        return json({ ok: true, savedAt });
      }
      await env.VM_SNAPSHOTS.delete(key);
      return json({ ok: true });
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return json({ status: "ok", service: "cloudflare-container-networking" });
    }

    if (url.pathname === "/debug/egress-ip") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

      try {
        const response = await fetch("https://api4.ipify.org?format=json");
        if (!response.ok) {
          return json({ error: "egress_ipv4_lookup_failed", upstream_status: response.status }, 502);
        }

        const data = (await response.json()) as { ip?: string };
        return json({ egress_ipv4: data.ip ?? null });
      } catch (error) {
        return json({
          error: "egress_ipv4_lookup_failed",
          detail: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    if (url.pathname === "/debug/fineproxy-tcp") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

      const target = { hostname: "104.245.241.241", port: 1085 };

      try {
        const socket = connect(target);
        const opened = await socket.opened;

        const writer = socket.writable.getWriter();
        const greeting = new Uint8Array([0x05, 0x01, 0x00]);
        await writer.write(greeting);

        const reader = socket.readable.getReader();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), 5000),
          ),
        ]);

        reader.releaseLock();
        writer.releaseLock();
        await socket.close();

        const bytes = result.value ? Array.from(result.value).map((b) => b.toString(16).padStart(2, "0")) : [];

        return json({
          target: "104.245.241.241:1085",
          tcp_connected: true,
          remote_address: opened.remoteAddress,
          local_address: opened.localAddress,
          socks5_greeting_response_hex: bytes.join(" "),
          socks5_no_auth_accepted: bytes.length >= 2 && bytes[0] === "05" && bytes[1] === "00",
        });
      } catch (error) {
        return json({
          target: "104.245.241.241:1085",
          tcp_connected: false,
          error: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    if (url.pathname === "/tunnel") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }

      const role = request.headers.get("x-tunnel-role");
      const nodeId = request.headers.get("x-node-id") ?? "";
      const expected =
        role === "gateway"
          ? env.TUNNEL_TOKEN
          : role === "client"
            ? env.CLIENT_TOKEN
            : undefined;

      if (!authorized(request.headers.get("authorization"), expected)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (!validNodeId(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const hub = env.TUNNEL_HUB.get(env.TUNNEL_HUB.idFromName("global"));
      return hub.fetch(request);
    }

    if (url.pathname === "/v1/nodes") {
      if (request.method !== "GET" && request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }

      const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));

      if (request.method === "GET") {
        return registry.fetch("https://node-registry.internal/list");
      }

      return registry.fetch(
        new Request("https://node-registry.internal/create", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    const runtimeMatch = url.pathname.match(
      /^\/v1\/nodes\/([^/]+)\/runtime(?:\/(start|stop|probe|heartbeat))?$/,
    );

    if (runtimeMatch) {
      const nodeId = runtimeMatch[1];
      const action = runtimeMatch[2];

      if (!validNodeId(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const runtime = env.NODE_RUNTIME.get(env.NODE_RUNTIME.idFromName(nodeId));

      if (!action && request.method === "GET") {
        return runtime.fetch("https://node-runtime.internal/status");
      }

      if (action === "start") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch("https://node-runtime.internal/start", { method: "POST" });
      }

      if (action === "stop") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch("https://node-runtime.internal/stop", { method: "POST" });
      }

      if (action === "probe") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch("https://node-runtime.internal/probe");
      }

      if (action === "heartbeat") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch(
          new Request("https://node-runtime.internal/heartbeat", {
            method: "POST",
            headers: request.headers,
            body: request.body,
          }),
        );
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    const nodeMatch = url.pathname.match(/^\/v1\/nodes\/([^/]+)$/);

    if (nodeMatch) {
      const nodeId = nodeMatch[1];
      if (!validNodeId(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));

      if (request.method === "GET") {
        return registry.fetch(
          `https://node-registry.internal/node/${encodeURIComponent(nodeId)}`,
        );
      }

      if (request.method === "PATCH") {
        return registry.fetch(
          new Request(
            `https://node-registry.internal/node/${encodeURIComponent(nodeId)}`,
            {
              method: "PATCH",
              headers: request.headers,
              body: request.body,
            },
          ),
        );
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
