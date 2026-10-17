import { DurableObject } from "cloudflare:workers";
import headlessV86Roundtrip from "./headless-v86-snapshot-roundtrip-worker";

interface ProvisionerEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  VM_SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
  NETWORK_RELAY_URL?: string;
}
interface ProvisioningJob {
  identity: string;
  username: string;
  status: "queued" | "running" | "complete" | "error";
  created_at: string;
}
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Durable coordinator: the VM initialization continues after the browser closes. */
export class AccountProvisioner extends DurableObject<ProvisionerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/start" || request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => null) as { identity?: unknown; username?: unknown } | null;
    const identity = typeof body?.identity === "string" ? body.identity.toLowerCase() : "";
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!/^acct-[a-f0-9-]{36}$/.test(identity) || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username)) {
      return json({ error: "invalid_provisioning_job" }, 400);
    }
    const existing = await this.ctx.storage.get<ProvisioningJob>("job");
    if (existing?.status === "running" || existing?.status === "queued") {
      return json({ accepted: true, status: existing.status, identity: existing.identity }, 202);
    }
    const job: ProvisioningJob = { identity, username, status: "queued", created_at: new Date().toISOString() };
    await this.ctx.storage.put("job", job);
    await this.env.VM_SNAPSHOTS.put("runtime-jobs/" + identity + ".json", JSON.stringify({
      identity, status: "queued", step: "queued", started_at: job.created_at, updated_at: job.created_at,
    }), { httpMetadata: { contentType: "application/json" } });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return json({ accepted: true, status: "queued", identity }, 202);
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<ProvisioningJob>("job");
    if (!job || job.status === "complete" || job.status === "error") return;
    job.status = "running";
    await this.ctx.storage.put("job", job);
    const auth = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName("auth-users"));
    const account = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName(job.identity));
    try {
      const response = await headlessV86Roundtrip.fetch(new Request("https://headless-v86.internal/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: job.identity }),
      }), this.env);
      const result = await response.json() as { passed?: boolean; boot_error?: string };
      if (!response.ok || result.passed !== true) {
        throw new Error(typeof result.boot_error === "string" ? result.boot_error : "headless_vm_roundtrip_failed");
      }
      const accountReady = await account.fetch("https://account-registry.internal/account/" + job.identity, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      });
      const authReady = await auth.fetch("https://account-registry.internal/auth/status", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: job.username, status: "ready" }),
      });
      if (!accountReady.ok || !authReady.ok) throw new Error("account_ready_transition_failed");
      job.status = "complete";
      await this.ctx.storage.put("job", job);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      job.status = "error";
      await this.ctx.storage.put("job", { ...job, error: message });
      await account.fetch("https://account-registry.internal/account/" + job.identity, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "error", error: message }),
      });
      await auth.fetch("https://account-registry.internal/auth/status", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: job.username, status: "error" }),
      });
      const progressKey = "runtime-jobs/" + job.identity + ".json";
      const priorObject = await this.env.VM_SNAPSHOTS.get(progressKey);
      const priorProgress = priorObject ? await priorObject.json() as Record<string, unknown> : {};
      await this.env.VM_SNAPSHOTS.put(progressKey, JSON.stringify({
        ...priorProgress, identity: job.identity, status: "error",
        step: typeof priorProgress.step === "string" ? priorProgress.step : "failed",
        error: message, updated_at: new Date().toISOString(),
      }), { httpMetadata: { contentType: "application/json" } });
    }
  }
}
