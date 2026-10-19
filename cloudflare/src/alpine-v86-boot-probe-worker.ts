import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

type ProbeResult = {
  probe: string;
  runtime: string;
  guest_booted: boolean;
  guest_login_seen: boolean;
  network_test_ran: boolean;
  network_test_passed: boolean;
  boot_error?: string;
  screen_excerpt: string;
  network_excerpt: string;
};

const ALPINE_ISO_URL = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86/alpine-virt-3.24.2-x86.iso";
const ALPINE_ISO_PATH = "/boot/alpine-virt-3.24.2-x86.iso";

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher; NETWORK_RELAY_URL?: string }) {
    if (new URL(request.url).pathname !== "/probe") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const base = new URL(request.url);
    const wasm = getCompiledV86WasmInfo();
    let emulator: any;
    let guestBooted = false;
    let loginSeen = false;
    let networkRan = false;
    let networkPassed = false;
    let bootError: string | undefined;
    let networkExcerpt = "";

    class AssetXMLHttpRequest {
      method = "GET";
      url = "";
      responseType = "";
      response: unknown = null;
      responseText = "";
      readyState = 0;
      status = 0;
      onreadystatechange: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
        this.readyState = 1;
        this.onreadystatechange?.();
      }
      setRequestHeader(_name: string, _value: string) {}
      getResponseHeader(_name: string) { return null; }
      getAllResponseHeaders() { return ""; }
      async send() {
        try {
          const target = new URL(this.url, request.url);
          // Keep the 49 MiB ISO out of the Workers static-assets bundle (25 MiB/file limit).
          // BIOS files remain served from the local ASSETS binding.
          const response = target.pathname === ALPINE_ISO_PATH
            ? await fetch(ALPINE_ISO_URL)
            : await env.ASSETS.fetch(new Request(target.toString(), { method: this.method }));
          this.status = response.status;
          if (this.responseType === "arraybuffer") {
            this.response = await response.arrayBuffer();
          } else {
            this.responseText = await response.text();
            this.response = this.responseText;
          }
          this.readyState = 4;
          this.onreadystatechange?.();
          this.onload?.();
        } catch {
          this.onerror?.();
        }
      }
    }
    (globalThis as unknown as { XMLHttpRequest: typeof AssetXMLHttpRequest }).XMLHttpRequest = AssetXMLHttpRequest;

    const relayUrl = env.NETWORK_RELAY_URL || "wss://relay.widgetry.org/";
    try {
      emulator = new V86({
        wasm_fn: createCompiledV86WasmFn(),
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        bios: { url: new URL("/bios/seabios.bin", base).toString() },
        vga_bios: { url: new URL("/bios/vgabios.bin", base).toString() },
        cdrom: { url: new URL(ALPINE_ISO_PATH, base).toString() },
        autostart: true,
        disable_keyboard: false,
        disable_mouse: true,
        net_device: { type: "virtio", relay_url: relayUrl },
      } as ConstructorParameters<typeof V86>[0]);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("v86_emulator_load_timeout")), 30000);
        emulator.add_listener("emulator-loaded", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      // Alpine's ISO may show a boot prompt before starting its live environment.
      try {
        const prompt = await emulator.wait_until_vga_screen_contains(/boot:/i, { timeout_msec: 12000 });
        if (prompt) {
          await emulator.keyboard_send_scancodes([0x1C, 0x9C]);
        }
      } catch {
        // Some boot configurations advance automatically.
      }

      try {
        loginSeen = Boolean(await emulator.wait_until_vga_screen_contains(/localhost login:|alpine login:|login:/i, { timeout_msec: 240000 }));
      } catch {
        loginSeen = false;
      }
      if (!loginSeen) throw new Error("alpine_login_prompt_not_seen_within_4_minutes");
      guestBooted = true;

      // The official Alpine live ISO permits root login without a configured password.
      await emulator.keyboard_send_text("root\n");
      let shellSeen = false;
      try {
        shellSeen = Boolean(await emulator.wait_until_vga_screen_contains(/localhost:~#|~#\s*$/m, { timeout_msec: 15000 }));
      } catch {
        shellSeen = false;
      }
      if (!shellSeen) throw new Error("alpine_root_shell_not_seen_after_login");

      const command = "echo ALPINE_NET_BEGIN; uname -a; cat /etc/os-release; (ip link set eth0 up 2>&1 || true); (udhcpc -i eth0 -n -q -t 5 2>&1 || true); echo ROUTES; ip route 2>&1; echo ADDRESSES; ip addr 2>&1; echo RESOLV; cat /etc/resolv.conf 2>&1; echo DNS_TEST; nslookup raw.githubusercontent.com 2>&1; dns_rc=$?; echo DNS_RC=$dns_rc; echo HTTPS_TEST; wget -T 12 -t 1 -S -O /dev/null https://example.com 2>&1; https_rc=$?; echo HTTPS_RC=$https_rc; if ip route | grep -q '^default' && [ $dns_rc -eq 0 ] && [ $https_rc -eq 0 ]; then echo ALPINE_NETWORK_PASS; else echo ALPINE_NETWORK_FAIL; fi; echo ALPINE_NET_DONE";
      await emulator.keyboard_send_text(command + "\n");
      try {
        networkRan = Boolean(await emulator.wait_until_vga_screen_contains(/ALPINE_NET_DONE/, { timeout_msec: 60000 }));
      } catch {
        networkRan = false;
      }
      try { networkExcerpt = emulator.screen_adapter?.get_text_screen?.().join("\n").slice(-8000) ?? ""; } catch {}
      networkPassed = networkRan && /ALPINE_NETWORK_PASS/.test(networkExcerpt);
    } catch (error) {
      bootError = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    }

    let screenExcerpt = "";
    try { screenExcerpt = emulator?.screen_adapter?.get_text_screen?.().join("\n").slice(-5000) ?? ""; } catch {}
    try { emulator?.stop(); } catch {}

    const result: ProbeResult = {
      probe: "alpine-v86-boot-network",
      runtime: "workerd",
      guest_booted: guestBooted,
      guest_login_seen: loginSeen,
      network_test_ran: networkRan,
      network_test_passed: networkPassed,
      ...(bootError ? { boot_error: bootError } : {}),
      screen_excerpt: screenExcerpt,
      network_excerpt: networkExcerpt,
    };
    return Response.json({ ...result, wasm_module_loaded: wasm.module_loaded, network_relay_configured: Boolean(relayUrl) }, {
      headers: { "cache-control": "no-store" },
      status: guestBooted ? 200 : 500,
    });
  },
};
