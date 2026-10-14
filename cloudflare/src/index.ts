import { connect } from "cloudflare:sockets";
import { TunnelHub } from "./tunnel-hub";
import { NodeRegistry } from "./node-registry";
import { NodeRuntime } from "./node-runtime";
export { TunnelHub, NodeRegistry, NodeRuntime };

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  NODE_REGISTRY: DurableObjectNamespace<NodeRegistry>;
  NODE_RUNTIME: DurableObjectNamespace<NodeRuntime>;
  ASSETS: Fetcher;
  TUNNEL_TOKEN: string;
  CLIENT_TOKEN: string;
  DASHBOARD_ACCESS_KEY?: string;
  DASHBOARD_SESSION_SECRET?: string;
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


const SESSION_COOKIE = "myst_dashboard_session";
const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

function constantTimeEqual(value: string, expected: string | undefined): boolean {
  if (!expected || value.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < value.length; i += 1) difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionSignature(expiry: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(expiry))));
}

async function validDashboardSession(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\\s*)myst_dashboard_session=([^;]+)/);
  if (!match) return false;
  const parts = match[1].split(".");
  if (parts.length !== 2 || !/^\\d{10,16}$/.test(parts[0])) return false;
  if (Number(parts[0]) <= Math.floor(Date.now() / 1000)) return false;
  const expected = await sessionSignature(parts[0], secret);
  return constantTimeEqual(parts[1], expected);
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


    if (url.pathname === "/api/dashboard-login") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "origin_not_allowed" }, 403);
      if (!env.DASHBOARD_ACCESS_KEY || !env.DASHBOARD_SESSION_SECRET) {
        return json({ error: "dashboard_auth_not_configured" }, 503);
      }
      let submittedKey = "";
      try {
        const body = (await request.json()) as { key?: unknown };
        if (typeof body.key === "string") submittedKey = body.key;
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (!constantTimeEqual(submittedKey, env.DASHBOARD_ACCESS_KEY)) {
        return json({ error: "invalid_access_key" }, 401);
      }
      const expiry = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
      const signature = await sessionSignature(expiry, env.DASHBOARD_SESSION_SECRET);
      return new Response(JSON.stringify({ ok: true, redirect: "/dashboard.html" }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=${expiry}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
        },
      });
    }

    if (url.pathname === "/api/dashboard-logout") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
        },
      });
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

    if (url.pathname === "/") {
      return Response.redirect(new URL("/dashboard.html", url), 302);
    }

    const protectedAsset =
      url.pathname === "/dashboard.html" ||
      url.pathname === "/vm.html" ||
      url.pathname.startsWith("/v86/") ||
      url.pathname.startsWith("/boot/");

    if (protectedAsset && !(await validDashboardSession(request, env.DASHBOARD_SESSION_SECRET))) {
      if (url.pathname.endsWith(".html") || request.headers.get("accept")?.includes("text/html")) {
        return Response.redirect(new URL("/access.html", url), 302);
      }
      return json({ error: "dashboard_access_required" }, 401);
    }

    return env.ASSETS.fetch(request);
  },
};
