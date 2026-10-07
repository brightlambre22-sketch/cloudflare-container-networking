import { DurableObject } from "cloudflare:workers";

export type NodeStatus = "provisioning" | "offline" | "online" | "error";

export interface VirtualNodeRecord {
  node_id: string;
  private_ip: string;
  status: NodeStatus;
  runtime: "control-plane-only" | "container-pending" | "external-gateway";
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

export class NodeRegistry extends DurableObject {
  private nodeKey(nodeId: string): string {
    return NODE_KEY_PREFIX + nodeId;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { node_id?: string };
      const nodeId = body.node_id ?? crypto.randomUUID();

      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) {
        return Response.json({ error: "invalid_node_id" }, { status: 400 });
      }

      if (await this.ctx.storage.get(this.nodeKey(nodeId))) {
        return Response.json({ error: "node_exists" }, { status: 409 });
      }

      const nextHost = Number((await this.ctx.storage.get<number>(NEXT_HOST_KEY)) ?? FIRST_HOST);
      if (!Number.isInteger(nextHost) || nextHost > MAX_HOST) {
        return Response.json({ error: "private_address_pool_exhausted" }, { status: 503 });
      }

      const now = new Date().toISOString();
      const record: VirtualNodeRecord = {
        node_id: nodeId,
        private_ip: hostToIp(nextHost),
        status: "provisioning",
        runtime: "control-plane-only",
        created_at: now,
        updated_at: now,
        egress_ip: null,
        last_health_at: null,
        error: null,
      };

      // SQLite-backed DO KV operations are synchronous. Keeping allocation in one
      // Durable Object makes the read/modify/write sequence atomic to this object.
      await this.ctx.storage.put(this.nodeKey(nodeId), record);
      await this.ctx.storage.put(NEXT_HOST_KEY, nextHost + 1);

      return Response.json(record, { status: 201 });
    }

    if (url.pathname === "/list" && request.method === "GET") {
      const nodes: VirtualNodeRecord[] = [];
      for (const [key, value] of await this.ctx.storage.list<VirtualNodeRecord>({ prefix: NODE_KEY_PREFIX })) {
        if (key.startsWith(NODE_KEY_PREFIX)) nodes.push(value as VirtualNodeRecord);
      }
      nodes.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return Response.json({ nodes });
    }

    if (url.pathname.startsWith("/node/")) {
      const nodeId = decodeURIComponent(url.pathname.slice("/node/".length));
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId)) {
        return Response.json({ error: "invalid_node_id" }, { status: 400 });
      }

      const key = this.nodeKey(nodeId);
      const existing = await this.ctx.storage.get<VirtualNodeRecord>(key);
      if (!existing) return Response.json({ error: "node_not_found" }, { status: 404 });

      if (request.method === "GET") return Response.json(existing);

      if (request.method === "PATCH") {
        const patch = await request.json().catch(() => ({})) as Partial<Pick<VirtualNodeRecord, "status" | "runtime" | "egress_ip" | "last_health_at" | "error">>;
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
  const third = Math.floor(host / 256);
  const fourth = host % 256;
  return `10.240.${third}.${fourth}`;
}
