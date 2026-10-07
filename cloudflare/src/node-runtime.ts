import { DurableObject } from "cloudflare:workers";

interface RuntimeState {
  node_id: string;
  status: "stopped" | "starting" | "running" | "error";
  started_at: string | null;
  last_error: string | null;
}

export class NodeRuntime extends DurableObject {
  private async state(): Promise<RuntimeState> {
    return (await this.ctx.storage.get<RuntimeState>("runtime")) ?? {
      node_id: this.ctx.id.toString(),
      status: "stopped",
      started_at: null,
      last_error: null,
    };
  }

  private async persist(state: RuntimeState): Promise<void> {
    await this.ctx.storage.put("runtime", state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const current = await this.state();

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        ...current,
        runtime: "external-runner",
        container_running: false,
      });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      const next: RuntimeState = {
        ...current,
        status: "running",
        started_at: current.started_at ?? new Date().toISOString(),
        last_error: null,
      };
      await this.persist(next);
      return Response.json({
        ...next,
        runtime: "external-runner",
        container_running: false,
      }, { status: 202 });
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      const next: RuntimeState = {
        ...current,
        status: "stopped",
      };
      await this.persist(next);
      return Response.json({
        ...next,
        runtime: "external-runner",
        container_running: false,
      });
    }

    if (url.pathname === "/probe" && request.method === "GET") {
      return Response.json({
        node_id: current.node_id,
        status: current.status,
        runtime: "external-runner",
        container_running: false,
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
