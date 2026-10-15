/**
 * Experimental Worker XHR compatibility shim for upstream v86's browser loader.
 * This is a feasibility probe only; URLs still need to be restricted before
 * this constructor is exposed to untrusted VM configuration.
 */
class FetchXMLHttpRequest {
  method = "GET";
  url = "";
  responseType = "";
  response: unknown = null;
  responseText = "";
  status = 0;
  timeout = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  private requestHeaders = new Headers();
  private responseHeaders = new Headers();

  open(method: string, url: string, _async = true) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders.set(name, value);
  }

  getResponseHeader(name: string) {
    return this.responseHeaders.get(name);
  }

  getAllResponseHeaders() {
    return [...this.responseHeaders.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n");
  }

  async send(body?: BodyInit | null) {
    const controller = new AbortController();
    const timer = this.timeout > 0
      ? setTimeout(() => controller.abort(), this.timeout)
      : undefined;
    try {
      // XHR accepts relative URLs; fetch in Workers requires an absolute URL.
      const base = (globalThis as { location?: Location }).location?.href;
      const url = base ? new URL(this.url, base).toString() : this.url;
      const response = await fetch(url, {
        method: this.method,
        headers: this.requestHeaders,
        body: body ?? undefined,
        signal: controller.signal,
      });
      this.status = response.status;
      this.responseHeaders = response.headers;
      if (this.responseType === "arraybuffer") {
        this.response = await response.arrayBuffer();
      } else {
        this.responseText = await response.text();
        this.response = this.responseText;
      }
      this.onload?.();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.ontimeout?.();
      } else {
        this.onerror?.();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

(globalThis as unknown as { XMLHttpRequest: typeof FetchXMLHttpRequest }).XMLHttpRequest = FetchXMLHttpRequest;

const { V86 } = await import("v86");
export { V86 };
export default V86;
