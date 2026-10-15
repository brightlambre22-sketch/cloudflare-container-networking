import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

const BOOT_TIMEOUT_MS = 60000;

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }) {
    if (new URL(request.url).pathname === "/ready") {
      return Response.json({ ready: true, probe: "headless-v86-tinycore-boot" });
    }
    const wasm = getCompiledV86WasmInfo();
    const base = new URL(request.url);
    let finish!: (value: { booted: boolean; reason?: string }) => void;
    const bootObserved = new Promise<{ booted: boolean; reason?: string }>((resolve) => {
      finish = resolve;
    });
    let started = false;
    let loaded = false;
    let emulator: any;

    class AssetXMLHttpRequest {
      method = "GET";
      url = "";
      responseType = "";
      response: unknown = null;
      responseText = "";
      readyState = 0;
      status = 0;
      onreadystatechange: (() => void) | null = null;
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      open(method: string, url: string) { this.method = method; this.url = url; this.readyState = 1; this.onreadystatechange?.(); }
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
          this.readyState = 4;
          this.onreadystatechange?.();
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
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        bios: { url: new URL("/bios/seabios.bin", base).toString() },
        vga_bios: { url: new URL("/bios/vgabios.bin", base).toString() },
        cdrom: { url: new URL("/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso", base).toString() },
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
        net_device: { type: "ne2k" },
      } as ConstructorParameters<typeof V86>[0]);
      emulator.add_listener("emulator-loaded", async () => {
        loaded = true;
        try {
          const bootPrompt = await emulator.wait_until_vga_screen_contains(
            /boot:/i,
            { timeout_msec: 5000 },
          );
          if (!bootPrompt) {
            finish({ booted: false, reason: "bootloader_prompt_not_seen_within_timeout" });
            return;
          }

          // Tiny Core ISO pauses at "boot:" until Enter selects its default entry.
          await emulator.keyboard_send_scancodes([0x1C, 0x9C]);
          const shellReached = await emulator.wait_until_vga_screen_contains(
            /tc@box|localhost login:|login:/i,
            { timeout_msec: BOOT_TIMEOUT_MS },
          );
          finish(shellReached
            ? { booted: true }
            : { booted: false, reason: "linux_shell_or_login_marker_not_seen_after_enter" });
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          finish({ booted: false, reason: "vga_probe_error: " + message });
        }
      });
      emulator.add_listener("emulator-started", () => { started = true; });
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

    let screenExcerpt = "";
    try {
      screenExcerpt = emulator?.screen_adapter?.get_text_screen?.().join("\n").slice(-2000) ?? "";
    } catch { /* screen diagnostics are best-effort */ }
    try { emulator?.stop(); } catch { /* Best-effort cleanup after bounded probe. */ }

    return new Response(JSON.stringify({
      probe: "headless-v86-tinycore-boot",
      runtime: "workerd",
      wasm_module_loaded: wasm.module_loaded,
      static_module_instantiated: true,
      emulator_initialized: loaded,
      emulator_started: started,
      guest_booted: result.booted,
      guest_boot_evidence: result.booted ? "vga_text_marker" : null,
      screen_excerpt: screenExcerpt,
      ...(result.reason ? { boot_error: result.reason } : {}),
      note: "Boots a small Tiny Core ISO without restoring the 103 MB snapshot. A VGA text marker is required to count as a boot.",
    }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
