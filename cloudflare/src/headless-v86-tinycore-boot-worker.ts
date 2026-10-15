import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

const BOOT_TIMEOUT_MS = 20000;
const MAX_SERIAL_BYTES = 8192;

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }) {
    const wasm = getCompiledV86WasmInfo();
    const base = new URL(request.url);
    const serial: string[] = [];
    let serialBytes = 0;
    let finish!: (value: { booted: boolean; reason?: string }) => void;
    const bootObserved = new Promise<{ booted: boolean; reason?: string }>((resolve) => {
      finish = resolve;
    });
    let started = false;
    let loaded = false;
    let emulator: InstanceType<typeof V86> | undefined;

    const observeSerial = (byte: number) => {
      if (serialBytes >= MAX_SERIAL_BYTES) return;
      serialBytes += 1;
      serial.push(String.fromCharCode(byte & 0xff));
      const output = serial.join("");
      if (/Linux version |Tiny Core Linux|tc@box|login:|localhost login:/i.test(output)) {
        finish({ booted: true });
      }
    };

    class AssetXMLHttpRequest {
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
      open(method: string, url: string) { this.method = method; this.url = url; }
      setRequestHeader(_name: string, _value: string) {}
      getResponseHeader(_name: string) { return null; }
      getAllResponseHeaders() { return ""; }
      async send() {
        try {
          const target = new URL(this.url, request.url);
          const response = await env.ASSETS.fetch(new Request(target.toString(), { method: this.method }));
          this.status = response.status;
          if (this.responseType === "arraybuffer") this.response = await response.arrayBuffer();
          else { this.responseText = await response.text(); this.response = this.responseText; }
          this.onload?.();
        } catch {
          this.onerror?.();
        }
      }
    }
    (globalThis as unknown as { XMLHttpRequest: typeof AssetXMLHttpRequest }).XMLHttpRequest = AssetXMLHttpRequest;

    try {
      emulator = new V86({
        wasm_fn: createCompiledV86WasmFn(),
        memory_size: 64 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        bios: { url: new URL("/bios/seabios.bin", base).toString() },
        vga_bios: { url: new URL("/bios/vgabios.bin", base).toString() },
        cdrom: { url: new URL("/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso", base).toString() },
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        net_device: { type: "ne2k" },
      } as ConstructorParameters<typeof V86>[0]);
      emulator.add_listener("emulator-loaded", () => { loaded = true; });
      emulator.add_listener("emulator-started", () => { started = true; });
      emulator.add_listener("serial0-output-byte", observeSerial);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      finish({ booted: false, reason: "constructor_error: " + message });
    }

    const result = await Promise.race([
      bootObserved,
      new Promise<{ booted: boolean; reason?: string }>((resolve) => setTimeout(
        () => resolve({ booted: false, reason: "guest_boot_marker_not_seen_within_timeout" }),
        BOOT_TIMEOUT_MS,
      )),
    ]);

    try { emulator?.stop(); } catch { /* Best-effort cleanup after bounded probe. */ }

    const serialOutput = serial.join("").replace(/[^\x20-\x7E\r\n\t]/g, ".");
    return new Response(JSON.stringify({
      probe: "headless-v86-tinycore-boot",
      runtime: "workerd",
      wasm_module_loaded: wasm.module_loaded,
      static_module_instantiated: true,
      emulator_initialized: loaded,
      emulator_started: started,
      guest_booted: result.booted,
      guest_boot_evidence: result.booted ? "serial_console_marker" : null,
      serial_bytes_seen: serialBytes,
      serial_excerpt: serialOutput.slice(-1200),
      ...(result.reason ? { boot_error: result.reason } : {}),
      note: "Boots a small Tiny Core ISO without restoring the 103 MB snapshot. A serial guest marker is required to count as a boot.",
    }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
