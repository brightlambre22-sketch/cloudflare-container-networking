import { DurableObject } from "cloudflare:workers";

export type AccountStatus = "provisioning" | "ready" | "error";

export interface AccountRecord {
  account_id: string;
  name: string;
  status: AccountStatus;
  baseline_id: string;
  snapshot_identity: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

interface StoredAccount extends AccountRecord {
  api_key_sha256: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function validAccountId(value: string): boolean {
  return /^acct-[a-f0-9-]{36}$/.test(value);
}

export class AccountRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        account_id?: unknown; name?: unknown; baseline_id?: unknown;
        snapshot_identity?: unknown; api_key_sha256?: unknown;
      } | null;
      if (!body || typeof body.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body.name !== "string" || body.name.length < 1 || body.name.length > 80 ||
          typeof body.baseline_id !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(body.baseline_id) ||
          typeof body.snapshot_identity !== "string" || !/^acct-[a-f0-9-]{36}$/.test(body.snapshot_identity) ||
          typeof body.api_key_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.api_key_sha256)) {
        return json({ error: "invalid_account_record" }, 400);
      }
      const key = "account:" + body.account_id;
      if (await this.ctx.storage.get(key)) return json({ error: "account_exists" }, 409);
      const now = new Date().toISOString();
      const record: StoredAccount = {
        account_id: body.account_id,
        name: body.name,
        status: "provisioning",
        baseline_id: body.baseline_id,
        snapshot_identity: body.snapshot_identity,
        created_at: now,
        updated_at: now,
        error: null,
        api_key_sha256: body.api_key_sha256,
      };
      await this.ctx.storage.put(key, record);
      return json({ account: this.publicRecord(record) }, 201);
    }

    const match = url.pathname.match(/^\/account\/([^/]+)$/);
    if (match) {
      const accountId = decodeURIComponent(match[1]);
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);
      const key = "account:" + accountId;
      const record = await this.ctx.storage.get<StoredAccount>(key);
      if (!record) return json({ error: "account_not_found" }, 404);

      if (request.method === "GET") {
        const suppliedHash = request.headers.get("x-account-key-sha256") ?? "";
        if (!/^[a-f0-9]{64}$/.test(suppliedHash) || !this.constantTimeEqual(suppliedHash, record.api_key_sha256)) {
          return json({ error: "unauthorized" }, 401);
        }
        return json({ account: this.publicRecord(record) });
      }

      if (request.method === "PATCH") {
        const body = await request.json().catch(() => ({})) as { status?: unknown; error?: unknown };
        if (body.status !== "ready" && body.status !== "error" && body.status !== "provisioning") {
          return json({ error: "invalid_account_status" }, 400);
        }
        const updated: StoredAccount = {
          ...record,
          status: body.status,
          error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
          updated_at: new Date().toISOString(),
        };
        await this.ctx.storage.put(key, updated);
        return json({ account: this.publicRecord(updated) });
      }
    }

    return json({ error: "not_found" }, 404);
  }

  private publicRecord(record: StoredAccount): AccountRecord {
    const { api_key_sha256: _secret, ...publicRecord } = record;
    return publicRecord;
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }
}
