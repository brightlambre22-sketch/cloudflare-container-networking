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

function authorized(
  header: string | null,
  expected: string | undefined,
): boolean {
  if (!header || !expected || !header.startsWith("Bearer ")) {
    return false;
  }

  const value = header.slice(7);

  if (value.length !== expected.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < value.length; i += 1) {
    difference |=
      value.charCodeAt(i) ^ expected.charCodeAt(i);
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

    /*
     * ------------------------------------------------------------
     * HEALTH
     * ------------------------------------------------------------
     */

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405);
      }

      return json({
        status: "ok",
        service: "cloudflare-container-networking",
      });
    }

    /*
     * ------------------------------------------------------------
     * TEMPORARY ADMIN AUTH DEBUG
     * ------------------------------------------------------------
     *
     * This endpoint intentionally NEVER returns the token.
     * Remove it after authentication debugging is complete.
     */

    if (url.pathname === "/debug/admin-auth") {
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405);
      }

      return json({
        admin_token_configured: Boolean(env.ADMIN_TOKEN),
        admin_token_length: env.ADMIN_TOKEN?.length ?? 0,
      });
    }

    /*
     * ------------------------------------------------------------
     * WEBSOCKET TUNNEL
     * ------------------------------------------------------------
     */

    if (url.pathname === "/tunnel") {
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405);
      }

      if (
        request.headers.get("upgrade")?.toLowerCase() !==
        "websocket"
      ) {
        return json(
          { error: "websocket_upgrade_required" },
          426,
        );
      }

      const role = request.headers.get("x-tunnel-role");
      const nodeId = request.headers.get("x-node-id") ?? "";

      const expected =
        role === "gateway"
          ? env.TUNNEL_TOKEN
          : role === "client"
            ? env.CLIENT_TOKEN
            : undefined;

      if (
        !authorized(
          request.headers.get("authorization"),
          expected,
        )
      ) {
        return json({ error: "unauthorized" }, 401);
      }

      if (!validNodeId(nodeId)) {
        return json(
          { error: "invalid_node_id" },
          400,
        );
      }

      const hub = env.TUNNEL_HUB.get(
        env.TUNNEL_HUB.idFromName("global"),
      );

      return hub.fetch(request);
    }

    /*
     * ------------------------------------------------------------
     * NODE REGISTRY
     * ------------------------------------------------------------
     */

    if (url.pathname === "/v1/nodes") {
      if (
        request.method !== "GET" &&
        request.method !== "POST"
      ) {
        return json(
          { error: "method_not_allowed" },
          405,
        );
      }

      if (
        !authorized(
          request.headers.get("authorization"),
          env.ADMIN_TOKEN,
        )
      ) {
        return json({ error: "unauthorized" }, 401);
      }

      const registry = env.NODE_REGISTRY.get(
        env.NODE_REGISTRY.idFromName("global"),
      );

      if (request.method === "GET") {
        return registry.fetch(
          "https://node-registry.internal/list",
        );
      }

      return registry.fetch(
        new Request(
          "https://node-registry.internal/create",
          {
            method: "POST",
            headers: request.headers,
            body: request.body,
          },
        ),
      );
    }

    /*
     * ------------------------------------------------------------
     * INDIVIDUAL NODE
     * ------------------------------------------------------------
     */

    const nodeMatch =
      url.pathname.match(/^\/v1\/nodes\/([^/]+)$/);

    if (nodeMatch) {
      const nodeId = nodeMatch[1];

      if (!validNodeId(nodeId)) {
        return json(
          { error: "invalid_node_id" },
          400,
        );
      }

      if (
        !authorized(
          request.headers.get("authorization"),
          env.ADMIN_TOKEN,
        )
      ) {
        return json({ error: "unauthorized" }, 401);
      }

      const registry = env.NODE_REGISTRY.get(
        env.NODE_REGISTRY.idFromName("global"),
      );

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

      return json(
        { error: "method_not_allowed" },
        405,
      );
    }

    /*
     * ------------------------------------------------------------
     * NODE RUNTIME
     * ------------------------------------------------------------
     */

    const runtimeMatch =
      url.pathname.match(
        /^\/v1\/nodes\/([^/]+)\/runtime(?:\/(start|stop|probe))?$/,
      );

    if (runtimeMatch) {
      const nodeId = runtimeMatch[1];
      const action = runtimeMatch[2];

      if (!validNodeId(nodeId)) {
        return json(
          { error: "invalid_node_id" },
          400,
        );
      }

      if (
        !authorized(
          request.headers.get("authorization"),
          env.ADMIN_TOKEN,
        )
      ) {
        return json({ error: "unauthorized" }, 401);
      }

      const runtime = env.NODE_RUNTIME.get(
        env.NODE_RUNTIME.idFromName(nodeId),
      );

      if (!action && request.method === "GET") {
        return runtime.fetch(
          "https://node-runtime.internal/status",
        );
      }

      if (action === "start") {
        if (request.method !== "POST") {
          return json(
            { error: "method_not_allowed" },
            405,
          );
        }

        return runtime.fetch(
          "https://node-runtime.internal/start",
          {
            method: "POST",
          },
        );
      }

      if (action === "stop") {
        if (request.method !== "POST") {
          return json(
            { error: "method_not_allowed" },
            405,
          );
        }

        return runtime.fetch(
          "https://node-runtime.internal/stop",
          {
            method: "POST",
          },
        );
      }

      if (action === "probe") {
        if (request.method !== "GET") {
          return json(
            { error: "method_not_allowed" },
            405,
          );
        }

        return runtime.fetch(
          "https://node-runtime.internal/probe",
        );
      }

      return json(
        { error: "method_not_allowed" },
        405,
      );
    }

    /*
     * ------------------------------------------------------------
     * NOT FOUND
     * ------------------------------------------------------------
     */

    return json(
      { error: "not_found" },
      404,
    );
  },
};
