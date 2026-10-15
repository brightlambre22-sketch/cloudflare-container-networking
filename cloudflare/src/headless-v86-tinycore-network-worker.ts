import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

const BOOT_TIMEOUT_MS = 300000;
const SHELL_COMMAND_TIMEOUT_MS = 20000;

type Stage = { attempted: boolean; passed: boolean; marker: string; error?: string; output?: string };

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher; NETWORK_RELAY_URL?: string }) {
    const path = new URL(request.url).pathname;
    if (path === "/ready") return Response.json({ ready: true, probe: "tinycore-dhcp-openssl-ca" });

    const wasm = getCompiledV86WasmInfo();
    const base = new URL(request.url);
    let finishBoot!: (value: { booted: boolean; reason?: string }) => void;
    const bootObserved = new Promise<{ booted: boolean; reason?: string }>((resolve) => { finishBoot = resolve; });
    let started = false;
    let loaded = false;
    let emulator: any;

    class AssetXMLHttpRequest {
      method = "GET"; url = ""; responseType = ""; response: unknown = null; responseText = "";
      readyState = 0; status = 0; onreadystatechange: (() => void) | null = null;
      timeout = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null;
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
          this.readyState = 4; this.onreadystatechange?.(); this.onload?.();
        } catch { this.onerror?.(); }
      }
    }
    (globalThis as unknown as { XMLHttpRequest: typeof AssetXMLHttpRequest }).XMLHttpRequest = AssetXMLHttpRequest;

    // Match the relay already used by the real browser VM in public/vm.html.
    // Keep this in fetch() scope because the DHCP stages and response also use it.
    // Allow CI to override it, but do not silently boot an unconnected NE2000 device.
    const relayUrl = env.NETWORK_RELAY_URL || "wss://relay.widgetry.org/";

    try {
      const netDevice: { type: "ne2k"; relay_url?: string } = { type: "ne2k", relay_url: relayUrl };
      emulator = new V86({
        wasm_fn: createCompiledV86WasmFn(),
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        bios: { url: new URL("/bios/seabios.bin", base).toString() },
        vga_bios: { url: new URL("/bios/vgabios.bin", base).toString() },
        cdrom: { url: new URL("/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso", base).toString() },
        autostart: true,
        disable_keyboard: false,
        disable_mouse: true,
        net_device: netDevice,
      } as ConstructorParameters<typeof V86>[0]);
      emulator.add_listener("emulator-loaded", async () => {
        loaded = true;
        try {
          const bootPrompt = await emulator.wait_until_vga_screen_contains(/boot:/i, { timeout_msec: 5000 });
          if (!bootPrompt) { finishBoot({ booted: false, reason: "bootloader_prompt_not_seen_within_timeout" }); return; }
          await emulator.keyboard_send_scancodes([0x1C, 0x9C]);
          const shellReached = await emulator.wait_until_vga_screen_contains(/tc@box:~\$|tc@box|localhost login:|login:/i, { timeout_msec: BOOT_TIMEOUT_MS });
          finishBoot(shellReached ? { booted: true } : { booted: false, reason: "linux_shell_or_login_marker_not_seen_after_enter" });
        } catch (error) {
          finishBoot({ booted: false, reason: "boot_probe_error: " + (error instanceof Error ? error.message : String(error)).slice(0, 250) });
        }
      });
      emulator.add_listener("emulator-started", () => { started = true; });
    } catch (error) {
      finishBoot({ booted: false, reason: "constructor_error: " + (error instanceof Error ? error.message : String(error)).slice(0, 250) });
    }

    const boot = await Promise.race([
      bootObserved,
      new Promise<{ booted: boolean; reason?: string }>((resolve) => setTimeout(() => resolve({ booted: false, reason: "guest_boot_timeout" }), BOOT_TIMEOUT_MS)),
    ]);

    const stages: Record<string, Stage> = {};
    const runStage = async (key: string, command: string, marker: string, timeout: number, asRoot = false): Promise<boolean> => {
      const stage: Stage = { attempted: true, passed: false, marker };
      stages[key] = stage;
      try {
        // Write each stage as a script first; long interactive command lines were being truncated by the guest shell.
        // Encode the complete marker, including delimiters, so it appears only after printf actually executes.
        const markerText = "__" + marker + "__";
        const markerFormat = "\\n" + Array.from(markerText, (char) => "\\\\" + char.charCodeAt(0).toString(8).padStart(3, "0")).join("") + "\\n";
        const runner = asRoot ? "sudo -n sh /tmp/headless-v86-stage.sh" : "sh /tmp/headless-v86-stage.sh";
        const script = "cat > /tmp/headless-v86-stage.sh <<'V86_STAGE_EOF'\\n" + command + "\\nV86_STAGE_EOF\\n" +
          runner + "\\nstage_rc=$?\\necho STAGE_SCRIPT_RC=$stage_rc\\nprintf '" + markerFormat + "'\\n";
        await emulator.keyboard_send_text(script);
        const observed = await emulator.wait_until_vga_screen_contains(new RegExp("__" + marker + "__"), { timeout_msec: timeout });
        let screen = "";
        try { screen = emulator.screen_adapter?.get_text_screen?.().join("\\n") ?? ""; } catch {}
        stage.output = screen.slice(-5000);
        stage.passed = Boolean(observed) && screen.includes("__" + marker + "__");
        if (!stage.passed) stage.error = "stage_marker_not_seen_within_timeout";
      } catch (error) {
        stage.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
      return stage.passed;
    };

    if (boot.booted) {
      // Reuse the known-good NETWORK INIT command from the user's real VM run.
      // Bound DHCP retries to six minutes so a broken relay cannot stall CI indefinitely.
      const dhcpCommand = `set +e
echo "--- NETWORK INIT ---"
id
iface=$(/sbin/ifconfig -a 2>/dev/null | grep -E "^(eth|en|wlan)" | head -n 1 | cut -d " " -f 1)
if [ -z "$iface" ]; then
  /sbin/modprobe ne2k-pci 2>&1
  /sbin/modprobe 8390 2>&1
  sleep 1
  iface=$(/sbin/ifconfig -a 2>/dev/null | grep -E "^(eth|en|wlan)" | head -n 1 | cut -d " " -f 1)
fi
echo DHCP_INTERFACE=$iface
if [ -z "$iface" ]; then
  echo NIC_MISSING
  cat /proc/net/dev
  dmesg 2>/dev/null | tail -n 20
  exit 1
fi
/sbin/ifconfig "$iface" up
tries=0
while [ "$tries" -lt 120 ]; do
  /sbin/udhcpc -f -n -q -i "$iface"
  if /sbin/ifconfig "$iface" | grep -Eq "inet (addr:)?[0-9]" && /sbin/route -n | grep -q "0.0.0.0"; then
    echo DHCP_OK
    exit 0
  fi
  echo DHCP_RETRYING_NO_LEASE
  tries=$((tries+1))
  sleep 3
done
echo DHCP_TIMEOUT
/sbin/ifconfig -a
/sbin/route -n
exit 1`;
      await runStage("resource_preflight",
        "echo \"--- RESOURCE PREFLIGHT ---\"; df -h / /tmp /usr/local/tce 2>&1; free 2>&1; cat /proc/meminfo 2>/dev/null | head -n 8; echo \"TLS prerequisite installation will run before HTTPS preflight.\"",
        "RESOURCE_PREFLIGHT_DONE", SHELL_COMMAND_TIMEOUT_MS);
      const dhcpPassed = await runStage("dhcp", dhcpCommand, "DHCP_DONE", 420000, true);
      const dhcpOutput = stages.dhcp.output ?? "";
      stages.dhcp.passed = dhcpPassed && /DHCP_OK/.test(dhcpOutput) && !/NIC_MISSING|DHCP_TIMEOUT/.test(dhcpOutput);
      if (!stages.dhcp.passed) stages.dhcp.error = /NIC_MISSING/.test(dhcpOutput)
        ? "guest_nic_missing"
        : /DHCP_TIMEOUT/.test(dhcpOutput) ? "no_dhcp_lease_and_default_route_within_six_minutes" : (stages.dhcp.error ?? "dhcp_stage_failed");

      if (stages.dhcp.passed) {
        await runStage("tls_download",
          "echo '--- TLS package downloads ---'; tce-load -w openssl-1.1.1.tcz; openssl_dl=$?; tce-load -w ca-certificates.tcz; ca_dl=$?; echo OPENSSL_DOWNLOAD_RC=$openssl_dl; echo CA_DOWNLOAD_RC=$ca_dl",
          "TLS_DOWNLOAD_DONE", 180000);
        const dlOut = stages.tls_download.output ?? "";
        stages.tls_download.passed = stages.tls_download.passed && /OPENSSL_DOWNLOAD_RC=0/.test(dlOut) && /CA_DOWNLOAD_RC=0/.test(dlOut);
        if (!stages.tls_download.passed) stages.tls_download.error = "openssl_or_ca_package_download_failed";

        if (stages.tls_download.passed) {
          await runStage("openssl_install",
            "echo '--- OpenSSL install ---'; tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1; install_rc=$?; if [ \"$install_rc\" -eq 0 ] && openssl version >/dev/null 2>&1; then rc=0; else rc=1; fi; echo OPENSSL_PATH=$(command -v openssl 2>/dev/null); echo OPENSSL_INSTALL_RC=$rc; openssl version 2>&1",
            "OPENSSL_INSTALL_DONE", 120000);
          const sslOut = stages.openssl_install.output ?? "";
          stages.openssl_install.passed = stages.openssl_install.passed && /OPENSSL_INSTALL_RC=0/.test(sslOut) && /OpenSSL 1\./.test(sslOut);
          if (!stages.openssl_install.passed) stages.openssl_install.error = "openssl_install_or_version_check_failed";

          await runStage("ca_install",
            "echo '--- CA certificate install ---'; tce-load -i ca-certificates >/tmp/ca.log 2>&1; rc=$?; echo CA_INSTALL_RC=$rc; tail -n 5 /tmp/ca.log; CA_BUNDLE=$(find /usr/local/etc/ssl/certs /etc/ssl/certs -type f -name ca-certificates.crt 2>/dev/null | head -n 1); echo CA_BUNDLE_PATH=$CA_BUNDLE; [ \"$rc\" -eq 0 ] && [ -s \"$CA_BUNDLE\" ]; rc=$?; echo CA_BUNDLE_CHECK_RC=$rc",
            "CA_CERTIFICATES_INSTALL_DONE", 120000);
          const caOut = stages.ca_install.output ?? "";
          stages.ca_install.passed = stages.ca_install.passed && /CA_INSTALL_RC=0/.test(caOut) && /CA_BUNDLE_CHECK_RC=0/.test(caOut);
          if (!stages.ca_install.passed) stages.ca_install.error = "ca_install_or_bundle_check_failed";

          if (stages.openssl_install.passed && stages.ca_install.passed) {
            await runStage("https_preflight",
              "echo '--- DNS / HTTPS PREFLIGHT ---'; cat /etc/resolv.conf 2>&1; wget -T 10 -t 1 -S -O /dev/null https://cloudflare-container-networking.brightlambre22-6dd.workers.dev/health >/tmp/https-preflight.log 2>&1; rc=$?; cat /tmp/https-preflight.log; echo HTTPS_PREFLIGHT_RC=$rc; [ \"$rc\" -eq 0 ] && echo INTERNET_HTTPS_OK || echo HTTPS_PREFLIGHT_FAILED",
              "EGRESS_PREFLIGHT_DONE", 120000);
            const httpsOut = stages.https_preflight.output ?? "";
            stages.https_preflight.passed = stages.https_preflight.passed && /HTTPS_PREFLIGHT_RC=0/.test(httpsOut) && /INTERNET_HTTPS_OK/.test(httpsOut);
            if (!stages.https_preflight.passed) stages.https_preflight.error = "guest_dns_or_https_preflight_failed";
          }
        }
      }
    }

    let screenExcerpt = "";
    try { screenExcerpt = emulator?.screen_adapter?.get_text_screen?.().join("\n").slice(-5000) ?? ""; } catch {}
    try { emulator?.stop(); } catch {}

    const passed = boot.booted && stages.dhcp?.passed === true &&
      stages.resource_preflight?.passed === true && stages.tls_download?.passed === true &&
      stages.openssl_install?.passed === true && stages.ca_install?.passed === true &&
      stages.https_preflight?.passed === true;
    return Response.json({
      probe: "tinycore-dhcp-openssl-ca",
      runtime: "workerd",
      wasm_module_loaded: wasm.module_loaded,
      emulator_initialized: loaded,
      emulator_started: started,
      guest_booted: boot.booted,
      guest_boot_evidence: boot.booted ? "vga_text_marker" : null,
      network_relay_configured: Boolean(relayUrl),
      network_relay_source: env.NETWORK_RELAY_URL ? "environment_override" : "same_default_as_public_vm_html",
      boot_error: boot.reason,
      stages,
      passed,
      screen_excerpt: screenExcerpt,
      note: "Tests only the guest DHCP/interface/default-route path, OpenSSL and CA package download/install, and HTTPS to the project's /health endpoint. Fineproxy and GitHub raw-content checks are intentionally excluded. This does not test snapshot persistence.",
    }, { headers: { "cache-control": "no-store" } });
  },
};
