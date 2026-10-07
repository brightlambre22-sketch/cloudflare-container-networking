import { DurableObject } from "cloudflare:workers";

interface RuntimeState {
  node_id: string;
  status: "stopped" | "starting" | "running" | "error";
  started_at: string | null;
  last_error: string | null;
}

interface Env {
  NODE_REGISTRY: DurableObjectNamespace;
}

const HEALTH_PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export class NodeRuntime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      });
    }
  }

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
        container_running: this.ctx.container.running,
        health_port: HEALTH_PORT,
      });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      if (this.ctx.container.running) {
        return Response.json({ ...current, container_running: true });
      }

      const starting: RuntimeState = {
        ...current,
        status: "starting",
        last_error: null,
      };
      await this.persist(starting);

      try {
        // This is a deliberately small runtime probe. It proves that a virtual
        // node can own a persistent Container instance with outbound Internet.
        // Mysterium is not started here because its documented Docker setup
        // requires NET_ADMIN and host networking, which must be validated
        // separately against Cloudflare Container capabilities.
        this.ctx.container.start({
          image: "cloudflare/debian-trixie",
          entrypoint: [
            "node",
            "-e",
            "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',runtime:'cloudflare-container'}))}).listen(8080,'0.0.0.0')"
          ],
          enableInternet: true,
          instance: "lite",
        });
        await this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

        const running: RuntimeState = {
          ...starting,
          status: "running",
          started_at: new Date().toISOString(),
        };
        await this.persist(running);
        this.ctx.waitUntil(this.watchContainer());
        return Response.json({ ...running, container_running: true }, { status: 202 });
      } catch (error) {
        const failed: RuntimeState = {
          ...starting,
          status: "error",
          last_error: error instanceof Error ? error.message : String(error),
        };
        await this.persist(failed);
        return Response.json(failed, { status: 502 });
      }
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      await this.ctx.container.destroy("virtual node stopped");
      const stopped: RuntimeState = { ...current, status: "stopped" };
      await this.persist(stopped);
      return Response.json({ ...stopped, container_running: false });
    }

    if (url.pathname === "/probe" && request.method === "GET") {
      if (!this.ctx.container.running) {
        return Response.json({ error: "container_not_running" }, { status: 409 });
      }
      try {
        const response = await this.ctx.container.getTcpPort(HEALTH_PORT).fetch("http://container/health");
        return new Response(response.body, {
          status: response.status,
          headers: response.headers,
        });
      } catch (error) {
        return Response.json({
          error: "container_not_ready",
          detail: error instanceof Error ? error.message : String(error),
        }, { status: 503 });
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async watchContainer(): Promise<void> {
    try {
      await this.ctx.container.monitor();
      const current = await this.state();
      await this.persist({ ...current, status: "stopped" });
    } catch (error) {
      const current = await this.state();
      await this.persist({
        ...current,
        status: "error",
        last_error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
