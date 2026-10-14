import { DurableObject } from "cloudflare:workers";

export type NodeStatus = "provisioning" | "offline" | "online" | "error";

export interface VirtualNodeRecord {
  node_id: string;
  private_ip: string;
  status: NodeStatus;
  runtime: "control-plane-only" | "container-pending" | "external-gateway" | "tinycore-persistent";
  created_at: string;
  updated_at: string;
  egress_ip: string | null;
  last_health_at: string | null;
  error: string | null;
}

const NODE_KEY_PREFIX = "node:";
const NEXT_HOST_KEY = "network:next_host";
const FIRST_HOST = 2;
const MAX_HOST = 65534;
const MAX_BATCH = 100;

export class NodeRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Authentication records are stored in this existing persistent Durable Object.
    if (url.pathname === "/auth/account" && request.method === "GET") {
      const username = (url.searchParams.get("username") ?? "").toLowerCase();
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        return Response.json({ error: "invalid_username" }, { status: 400 });
      }
      const account = await this.ctx.storage.get<{ username: string; salt: string; passwordHash: string }>("auth:user:" + username);
      return account ? Response.json(account) : Response.json({ error: "account_not_found" }, { status: 404 });
    }

    if (url.pathname === "/auth/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { username?: string; salt?: string; passwordHash?: string };
      const username = typeof body.username === "string" ? body.username.toLowerCase() : "";
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username) ||
          typeof body.salt !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(body.salt) ||
          typeof body.passwordHash !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(body.passwordHash)) {
        return Response.json({ error: "invalid_registration" }, { status: 400 });
      }
      const key = "auth:user:" + username;
      if (await this.ctx.storage.get(key)) return Response.json({ error: "username_taken" }, { status: 409 });
      await this.ctx.storage.put(key, { username, salt: body.salt, passwordHash: body.passwordHash });
      return Response.json({ ok: true, username }, { status: 201 });
    }

    if (url.pathname === "/auth/session" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { token?: string; username?: string; expiresAt?: number };
      if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(body.token) ||
          typeof body.username !== "string" || typeof body.expiresAt !== "number" ||
          !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
        return Response.json({ error: "invalid_session" }, { status: 400 });
      }
      await this.ctx.storage.put("auth:session:" + body.token, {
        username: body.username.toLowerCase(),
        expiresAt: body.expiresAt,
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/auth/session" && request.method === "GET") {
      const token = url.searchParams.get("token") ?? "";
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return Response.json({ error: "invalid_session" }, { status: 401 });
      const session = await this.ctx.storage.get<{ username: string; expiresAt: number }>("auth:session:" + token);
      if (!session || session.expiresAt <= Date.now()) {
        if (session) await this.ctx.storage.delete("auth:session:" + token);
        return Response.json({ error: "invalid_session" }, { status: 401 });
      }
      return Response.json({ ok: true, username: session.username, expiresAt: session.expiresAt });
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { token?: string };
      if (typeof body.token === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(body.token)) {
        await this.ctx.storage.delete("auth:session:" + body.token);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as {
        node_id?: string;
        count?: number;
      };
      const count = body.count === undefined ? 1 : Number(body.count);

      if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
        return Response.json({ error: "invalid_count", max: MAX_BATCH }, { status: 400 });
      }
      if (body.node_id !== undefined && count !== 1) {
        return Response.json({ error: "node_id_requires_count_1" }, { status: 400 });
      }

      const nextHost = Number(
        (await this.ctx.storage.get<number>(NEXT_HOST_KEY)) ?? FIRST_HOST,
      );

      if (!Number.isInteger(nextHost) || nextHost < FIRST_HOST || nextHost + count - 1 > MAX_HOST) {
        return Response.json({ error: "private_address_pool_exhausted" }, { status: 503 });
      }

      const now = new Date().toISOString();
      const records: VirtualNodeRecord[] = [];

      for (let i = 0; i < count; i += 1) {
        const nodeId = body.node_id ?? crypto.randomUUID();
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) {
          return Response.json({ error: "invalid_node_id" }, { status: 400 });
        }

        const key = NODE_KEY_PREFIX + nodeId;
        if (await this.ctx.storage.get(key)) {
          return Response.json({ error: "node_exists", node_id: nodeId }, { status: 409 });
        }

        const record: VirtualNodeRecord = {
          node_id: nodeId,
          private_ip: hostToIp(nextHost + i),
          status: "provisioning",
          runtime: "control-plane-only",
          created_at: now,
          updated_at: now,
          egress_ip: null,
          last_health_at: null,
          error: null,
        };

        records.push(record);
        await this.ctx.storage.put(key, record);
      }

      await this.ctx.storage.put(NEXT_HOST_KEY, nextHost + count);
      return Response.json(count === 1 ? records[0] : { nodes: records }, { status: 201 });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const nodes: VirtualNodeRecord[] = [];
      for (const [, value] of await this.ctx.storage.list<VirtualNodeRecord>({ prefix: NODE_KEY_PREFIX })) {
        nodes.push(value);
      }
      nodes.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return Response.json({ nodes });
    }

    if (url.pathname.startsWith("/node/")) {
      const nodeId = decodeURIComponent(url.pathname.slice("/node/".length));
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) {
        return Response.json({ error: "invalid_node_id" }, { status: 400 });
      }

      const key = NODE_KEY_PREFIX + nodeId;
      const existing = await this.ctx.storage.get<VirtualNodeRecord>(key);
      if (!existing) return Response.json({ error: "node_not_found" }, { status: 404 });
      if (request.method === "GET") return Response.json(existing);

      if (request.method === "PATCH") {
        const patch = await request.json().catch(() => ({})) as Partial<
          Pick<VirtualNodeRecord, "status" | "runtime" | "egress_ip" | "last_health_at" | "error">
        >;
        const updated: VirtualNodeRecord = {
          ...existing,
          ...patch,
          node_id: existing.node_id,
          private_ip: existing.private_ip,
          created_at: existing.created_at,
          updated_at: new Date().toISOString(),
        };
        await this.ctx.storage.put(key, updated);
        return Response.json(updated);
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

function hostToIp(host: number): string {
  return `10.240.${Math.floor(host / 256)}.${host % 256}`;
}
