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

async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310000 }, key, 256);
  return base64Url(new Uint8Array(bits));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sessionSignature(expiry: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(expiry))));
}

async function authStore(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));
  return registry.fetch(new Request("https://node-registry.internal" + path, init));
}

async function validDashboardSession(request: Request, env: Env): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\\s*)myst_dashboard_session=([^;]+)/);
  if (!match) return false;
  const response = await authStore(env, "/auth/session?token=" + encodeURIComponent(match[1]));
  return response.ok;
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


    if (url.pathname === "/api/auth/register" || url.pathname === "/api/auth/login") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "origin_not_allowed" }, 403);
      let body: { username?: unknown; password?: unknown } = {};
      try { body = await request.json() as { username?: unknown; password?: unknown }; }
      catch { return json({ error: "invalid_request" }, 400); }
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return json({ error: "invalid_username", message: "Use 3–32 letters, numbers, dots, underscores, or hyphens." }, 400);
      }
      if (password.length < 12 || password.length > 256) {
        return json({ error: "invalid_password", message: "Password must be at least 12 characters." }, 400);
      }

      const accountResponse = await authStore(env, "/auth/account?username=" + encodeURIComponent(username));
      if (url.pathname === "/api/auth/register") {
        if (accountResponse.ok) return json({ error: "username_taken", message: "That username is already registered." }, 409);
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        const salt = base64Url(saltBytes);
        const passwordHash = await hashPassword(password, saltBytes);
        const created = await authStore(env, "/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, salt, passwordHash }),
        });
        if (created.status === 409) return json({ error: "username_taken", message: "That username is already registered." }, 409);
        if (!created.ok) return json({ error: "registration_failed" }, 500);
      } else {
        if (!accountResponse.ok) return json({ error: "invalid_credentials", message: "Username or password is incorrect." }, 401);
        const account = await accountResponse.json() as { username: string; salt: string; passwordHash: string };
        const saltBytes = Uint8Array.from(atob(account.salt.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((account.salt.length + 3) % 4)), c => c.charCodeAt(0));
        const candidate = await hashPassword(password, saltBytes);
        if (!constantTimeEqual(candidate, account.passwordHash)) {
          return json({ error: "invalid_credentials", message: "Username or password is incorrect." }, 401);
        }
      }

      const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const expiresAt = Date.now() + SESSION_SECONDS * 1000;
      const saved = await authStore(env, "/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, username, expiresAt }),
      });
      if (!saved.ok) return json({ error: "session_creation_failed" }, 500);
      return new Response(JSON.stringify({ ok: true, redirect: "/dashboard.html" }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
        },
      });
    }

    if (url.pathname === "/api/auth/logout") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const cookie = request.headers.get("cookie") ?? "";
      const match = cookie.match(/(?:^|;\\s*)myst_dashboard_session=([^;]+)/);
      if (match) {
        await authStore(env, "/auth/logout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: match[1] }),
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
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
      return Response.redirect(new URL("/access.html", url), 302);
    }

    const protectedAsset =
      url.pathname === "/dashboard.html" ||
      url.pathname === "/vm.html" ||
      url.pathname.startsWith("/v86/") ||
      url.pathname.startsWith("/boot/");

    if (protectedAsset && !(await validDashboardSession(request))) {
      if (url.pathname.endsWith(".html") || request.headers.get("accept")?.includes("text/html")) {
        return Response.redirect(new URL("/access.html", url), 302);
      }
      return json({ error: "dashboard_access_required" }, 401);
    }

    return env.ASSETS.fetch(request);
  },
};
