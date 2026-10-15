import { DurableObject } from "cloudflare:workers";

export interface RegistrationJob {
  username: string;
  registrationId: string;
}

export interface RegistrationEnv {
  REGISTRATION_QUEUE: Queue<RegistrationJob>;
}

type RegistrationStatus = "queued" | "ready" | "failed";

interface AccountRecord {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  registrationId: string;
  status: RegistrationStatus;
  dispatchPending: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

const ACCOUNT_PREFIX = "account:";
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 256;
const PBKDF2_ITERATIONS = 120_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function publicRecord(record: AccountRecord) {
  return {
    username: record.username,
    registrationId: record.registrationId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.error ? { error: record.error } : {}),
  };
}

export class RegistrationRegistry extends DurableObject<RegistrationEnv> {
  private accountKey(username: string): string {
    return ACCOUNT_PREFIX + username;
  }

  private async getAccount(username: string): Promise<AccountRecord | undefined> {
    return this.ctx.storage.get<AccountRecord>(this.accountKey(username));
  }

  private async ensureTestAccounts(): Promise<void> {
    for (const [username, password] of [["usera", "test123"], ["userb", "test123"]]) {
      if (await this.getAccount(username)) continue;
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const passwordSalt = bytesToHex(saltBytes);
      const now = new Date().toISOString();
      const record: AccountRecord = {
        username,
        passwordSalt,
        passwordHash: await hashPassword(password, passwordSalt),
        registrationId: crypto.randomUUID(),
        status: "ready",
        dispatchPending: false,
        createdAt: now,
        updatedAt: now,
      };
      await this.ctx.storage.put(this.accountKey(username), record);
    }
  }

  private async dispatch(record: AccountRecord, scheduleAlarm = true): Promise<boolean> {
    if (scheduleAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    try {
      await this.env.REGISTRATION_QUEUE.send({
        username: record.username,
        registrationId: record.registrationId,
      });
      const latest = await this.getAccount(record.username);
      if (
        latest &&
        latest.registrationId === record.registrationId &&
        latest.status === "queued"
      ) {
        await this.ctx.storage.put(this.accountKey(record.username), {
          ...latest,
          dispatchPending: false,
          updatedAt: new Date().toISOString(),
        });
      }
      return true;
    } catch {
      const latest = await this.getAccount(record.username);
      if (latest && latest.registrationId === record.registrationId && latest.status === "queued") {
        await this.ctx.storage.put(this.accountKey(record.username), {
          ...latest,
          dispatchPending: true,
          updatedAt: new Date().toISOString(),
        });
      }
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return false;
    }
  }

  async alarm(): Promise<void> {
    const accounts = await this.ctx.storage.list<AccountRecord>({ prefix: ACCOUNT_PREFIX });
    const pending = Array.from(accounts.values()).filter(
      (record) => record.status === "queued" && record.dispatchPending,
    );
    for (const record of pending) {
      await this.dispatch(record, false);
    }
    const remaining = await this.ctx.storage.list<AccountRecord>({ prefix: ACCOUNT_PREFIX });
    if (Array.from(remaining.values()).some((record) => record.status === "queued" && record.dispatchPending)) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!USERNAME_PATTERN.test(username)) {
        return json({ error: "invalid_username", message: "Username must be 2–32 characters: letters, numbers, _ or -." }, 400);
      }
      if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        return json({ error: "invalid_password", message: "Password must be between 6 and 256 characters." }, 400);
      }

      await this.ensureTestAccounts();
      const existing = await this.getAccount(username);
      if (existing) {
        const candidateHash = await hashPassword(password, existing.passwordSalt);
        if (!sameSecret(candidateHash, existing.passwordHash)) {
          return json({ error: "username_taken", message: "That username already exists." }, 409);
        }
        if (existing.status === "failed") {
          const retry: AccountRecord = {
            ...existing,
            status: "queued",
            dispatchPending: true,
            error: undefined,
            updatedAt: new Date().toISOString(),
          };
          await this.ctx.storage.put(this.accountKey(username), retry);
          await this.dispatch(retry);
          return json({ account: publicRecord(await this.getAccount(username) ?? retry), accepted: true }, 202);
        }
        if (existing.status === "queued" && existing.dispatchPending) await this.dispatch(existing);
        const current = await this.getAccount(username) ?? existing;
        return json({ account: publicRecord(current), accepted: true }, current.status === "ready" ? 200 : 202);
      }

      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const passwordSalt = bytesToHex(saltBytes);
      const now = new Date().toISOString();
      const record: AccountRecord = {
        username,
        passwordSalt,
        passwordHash: await hashPassword(password, passwordSalt),
        registrationId: crypto.randomUUID(),
        status: "queued",
        dispatchPending: true,
        createdAt: now,
        updatedAt: now,
      };
      await this.ctx.storage.put(this.accountKey(username), record);
      await this.dispatch(record);
      const current = await this.getAccount(username) ?? record;
      return json({ account: publicRecord(current), accepted: true }, 202);
    }

    if (url.pathname === "/login" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!USERNAME_PATTERN.test(username) || !password) {
        return json({ error: "invalid_credentials", message: "Incorrect username or password." }, 401);
      }
      await this.ensureTestAccounts();
      const record = await this.getAccount(username);
      if (!record) return json({ error: "account_not_found", message: "Account not found." }, 404);
      const candidateHash = await hashPassword(password, record.passwordSalt);
      if (!sameSecret(candidateHash, record.passwordHash)) {
        return json({ error: "invalid_credentials", message: "Incorrect username or password." }, 401);
      }
      if (record.status === "queued" && record.dispatchPending) await this.dispatch(record);
      return json({ account: publicRecord(await this.getAccount(username) ?? record) });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const username = (url.searchParams.get("username") ?? "").trim().toLowerCase();
      const registrationId = url.searchParams.get("registrationId") ?? "";
      if (!USERNAME_PATTERN.test(username) || !registrationId) {
        return json({ error: "invalid_registration_reference" }, 400);
      }
      const record = await this.getAccount(username);
      if (!record || record.registrationId !== registrationId) {
        return json({ error: "registration_not_found" }, 404);
      }
      return json({ account: publicRecord(record) });
    }

    if (url.pathname === "/complete" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; registrationId?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const registrationId = typeof body?.registrationId === "string" ? body.registrationId : "";
      if (!USERNAME_PATTERN.test(username) || !registrationId) return json({ error: "invalid_job" }, 400);
      const record = await this.getAccount(username);
      if (!record || record.registrationId !== registrationId) return json({ error: "registration_not_found" }, 404);
      if (record.status !== "ready") {
        await this.ctx.storage.put(this.accountKey(username), {
          ...record,
          status: "ready",
          dispatchPending: false,
          error: undefined,
          updatedAt: new Date().toISOString(),
        } satisfies AccountRecord);
      }
      return json({ ok: true });
    }

    if (url.pathname === "/fail" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; registrationId?: unknown; error?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const registrationId = typeof body?.registrationId === "string" ? body.registrationId : "";
      if (!USERNAME_PATTERN.test(username) || !registrationId) return json({ error: "invalid_job" }, 400);
      const record = await this.getAccount(username);
      if (!record || record.registrationId !== registrationId) return json({ error: "registration_not_found" }, 404);
      await this.ctx.storage.put(this.accountKey(username), {
        ...record,
        status: "failed",
        dispatchPending: false,
        error: typeof body?.error === "string" ? body.error.slice(0, 200) : "Registration queue processing failed.",
        updatedAt: new Date().toISOString(),
      } satisfies AccountRecord);
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  }
}
