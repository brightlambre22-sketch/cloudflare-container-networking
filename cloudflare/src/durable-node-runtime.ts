import { DurableObject } from "cloudflare:workers";

export class DurableNodeRuntime extends DurableObject {
  async fetch(): Promise<Response> {
    return Response.json({ status: "stopped", container_running: this.ctx.container.running });
  }
}
