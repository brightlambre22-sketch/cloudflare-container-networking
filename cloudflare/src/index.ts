import { connect } from "cloudflare:sockets";
import { ADMIN_ACCESS_CODE } from "./auth-codes";
import { TunnelHub } from "./tunnel-hub";
import { NodeRegistry } from "./node-registry";
import { NodeRuntime } from "./node-runtime";
import { VmExecution } from "./vm-execution";
export { TunnelHub, NodeRegistry, NodeRuntime, VmExecution };

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  NODE_REGISTRY: DurableObjectNamespace<NodeRegistry>;
  NODE_RUNTIME: DurableObjectNamespace<NodeRuntime>;
  VM_EXECUTION: DurableObjectNamespace<VmExecution>;
  VM_API_TOKEN?: string;
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

    if (url.pathname === "/api/vm/agent-ticket") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("x-admin-code") !== ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);
      const vmId = "admin";
      const ticket = crypto.randomUUID();
      const coordinator = env.VM_EXECUTION.get(env.VM_EXECUTION.idFromName(vmId));
      const ticketResponse = await coordinator.fetch("https://vm-execution.internal/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, identity: vmId }),
      });
      if (!ticketResponse.ok) return json({ error: "agent_ticket_creation_failed" }, 502);
      return json({ ticket, vm_id: vmId, expires_in_seconds: 60 });
    }

    if (url.pathname === "/api/vm/agent") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      const coordinator = env.VM_EXECUTION.get(env.VM_EXECUTION.idFromName("admin"));
      return coordinator.fetch(new Request("https://vm-execution.internal/agent?ticket=" + encodeURIComponent(ticket), request));
    }

    if (url.pathname === "/v1/vm/status" || url.pathname === "/v1/vm/exec") {
      if (!env.VM_API_TOKEN) return json({ error: "vm_api_not_configured" }, 503);
      if (!authorized(request.headers.get("authorization"), env.VM_API_TOKEN)) return json({ error: "unauthorized" }, 401);
      const vmId = request.headers.get("x-vm-id") ?? "admin";
      if (vmId !== "admin") return json({ error: "unknown_vm_id", supported_vm_ids: ["admin"] }, 404);
      const coordinator = env.VM_EXECUTION.get(env.VM_EXECUTION.idFromName(vmId));
      if (url.pathname.endsWith("/status")) {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return coordinator.fetch("https://vm-execution.internal/status?identity=admin");
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const raw = await request.text();
      if (raw.length > 8192) return json({ error: "body_too_large" }, 413);
      return coordinator.fetch(new Request("https://vm-execution.internal/exec", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vm-id": vmId },
        body: raw,
      }));
    }

    const snapshotChunkMatch = url.pathname.match(/^\/api\/vm-snapshots\/([a-z0-9._-]{1,64})\/chunks\/([a-z0-9-]{1,40})\/([0-9]{1,3})$/i);
    const snapshotMatch = url.pathname.match(/^\/api\/vm-snapshots\/([a-z0-9._-]{1,64})$/i);
    const snapshotIdentity = snapshotChunkMatch?.[1] ?? snapshotMatch?.[1];
    if (snapshotIdentity) {
      const identity = snapshotIdentity.toLowerCase();
      const isAdmin = identity === "admin";
      if (isAdmin && request.headers.get("x-admin-code") !== ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);
      if (snapshotChunkMatch) {
        if (request.method !== "GET" && request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
        const generation = snapshotChunkMatch[2];
        const part = Number(snapshotChunkMatch[3]);
        const key = `vm-snapshots/${identity}/${generation}/${part}.bin`;
        if (request.method === "GET") {
          const object = await env.VM_SNAPSHOTS.get(key);
          if (!object) return json({ error: "snapshot_chunk_not_found" }, 404);
          return new Response(object.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        }
        if (!request.body) return json({ error: "empty_snapshot_chunk" }, 400);
        await env.VM_SNAPSHOTS.put(key, request.body, { httpMetadata: { contentType: "application/octet-stream" } });
        return json({ ok: true });
      }

      if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
      const prefix = `vm-snapshots/${identity}/`;
      const manifestKey = prefix + "manifest.json";
      if (request.method === "GET") {
        const object = await env.VM_SNAPSHOTS.get(manifestKey);
        if (!object) return json({ error: "snapshot_not_found" }, 404);
        const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        headers.set("x-snapshot-saved-at", object.customMetadata?.savedAt ?? object.uploaded.toISOString());
        return new Response(object.body, { headers });
      }
      if (request.method === "PUT") {
        let manifest: { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown };
        try { manifest = (await request.json()) as { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown }; }
        catch { return json({ error: "invalid_manifest" }, 400); }
        if (
          manifest.version !== 1 ||
          typeof manifest.generation !== "string" ||
          !/^[a-z0-9-]{1,40}$/.test(manifest.generation) ||
          !Number.isInteger(manifest.chunks) || (manifest.chunks as number) < 1 || (manifest.chunks as number) > 128 ||
          !Number.isInteger(manifest.byteLength) || (manifest.byteLength as number) < 1 || (manifest.byteLength as number) > 536870912 || manifest.chunks !== Math.ceil((manifest.byteLength as number) / 8388608)
        ) return json({ error: "invalid_manifest" }, 400);
        const generation = manifest.generation;
        const count = manifest.chunks as number;
        const present = await Promise.all(Array.from({ length: count }, (_, part) =>
          env.VM_SNAPSHOTS.head(`${prefix}${generation}/${part}.bin`),
        ));
        if (present.some((part) => !part)) return json({ error: "snapshot_chunk_missing" }, 400);
        const savedAt = new Date().toISOString();
        await env.VM_SNAPSHOTS.put(manifestKey, JSON.stringify({
          version: 1, generation, chunks: count, byteLength: manifest.byteLength, savedAt,
        }), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { savedAt },
        });
        let cursor: string | undefined;
        do {
          const page = await env.VM_SNAPSHOTS.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
          const stale = page.objects
            .filter((object) => object.key !== manifestKey && !object.key.startsWith(`${prefix}${generation}/`))
            .map((object) => object.key);
          if (stale.length) await env.VM_SNAPSHOTS.delete(stale);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return json({ ok: true, savedAt });
      }
      let cursor: string | undefined;
      do {
        const page = await env.VM_SNAPSHOTS.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        if (page.objects.length) await env.VM_SNAPSHOTS.delete(page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
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
