import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../public/runner/tinycore/browser-bootstrap.sh", import.meta.url), "utf8");

test("inline browser scripts parse", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.some((match) => match[1].trim()), "expected an inline script");
  for (const match of scripts) {
    const source = match[1].trim();
    if (source) assert.doesNotThrow(() => new Function(source));
  }
});

test("shell prompt detection tolerates blank rows but only accepts the current last line", () => {
  const match = html.match(/function shellPrompt\(text\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "shellPrompt function should exist");
  const shellPrompt = vm.runInNewContext("(" + match[0] + ")");
  assert.equal(shellPrompt("boot output\n tc@box:~$\n\n\n"), "tc@box:~$");
  assert.equal(shellPrompt("tc@box:~$\ncommand still running\n\n"), "");
});

test("VM uses a built ISO asset, a single supported relay configuration, and retries DHCP until a lease is valid", () => {
  assert.ok(html.includes("cdrom:{url:'/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso'}"), "VM should use the existing NIC-enabled experimental ISO");
  assert.ok(html.includes("net_device:{type:'ne2k',relay_url:'wss://relay.widgetry.org/'}"));
  assert.ok(html.includes("network_relay_url:'wss://relay.widgetry.org/'"), "retain relay fallback for this deployed v86 runtime");
  assert.ok(html.includes("SNAPSHOT_KEY='tinycore-main-v5'"), "network changes should invalidate stale saved NIC and unfinished-shell state");
  assert.ok(html.includes("while :; do /sbin/udhcpc -f -n -q -i \"$iface\";"), "DHCP should retry instead of abandoning the relay after three discovers");
  assert.ok(html.includes("/sbin/modprobe ne2k-pci"), "try loading the NE2000 PCI driver when no interface is present");
  assert.ok(html.includes("NIC_MISSING"), "report driver diagnostics instead of retrying DHCP forever without a NIC");
  assert.ok(html.includes("DHCP_RETRYING_NO_LEASE"));
  assert.ok(html.includes("echo DHCP_OK"), "successful DHCP path should emit its completion marker");
  const firstCommand = html.match(/const commands=\[\s*`([\s\S]*?)`,/);
  assert.ok(firstCommand, "first startup command should be present");
  assert.ok(firstCommand[1].length < 900, "network init command must stay short enough to avoid terminal input truncation");
});

test("startup prompt detection supports changed hostnames and explicitly wakes the shell before the first command", () => {
  assert.ok(html.includes("[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+"), "prompt detection should not depend on one exact hostname");
  assert.ok(html.includes("KEYBOARD INPUT WAKE"));
  assert.ok(html.includes("await sendVmCommand('\\n')"));
});

test("startup completion markers match the sequential command controller", () => {
  const normalized = html.replace(/"\s*"/g, "");
  for (const marker of [
    "DHCP_DONE",
    "__RESOURCE_PREFLIGHT_DONE",
    "__TLS_DOWNLOAD_DONE:",
    "__OPENSSL_INSTALL_DONE:",
    "__CA_CERTIFICATES_INSTALL_DONE:",
    "__EGRESS_PREFLIGHT_DONE:",
    "__NETWORK_DOWNLOAD_DONE:",
    "__NETWORK_TEST_DONE:",
    "__FINEPROXY_DOWNLOAD_DONE:",
    "__FINEPROXY_TEST_DONE:"
  ]) {
    assert.ok(normalized.includes(marker), "expected startup marker: " + marker);
  }
});

test("TLS installs run in the foreground before HTTPS and certificate checks", () => {
  assert.ok(html.includes("tce-load -w openssl-1.1.1.tcz"));
  assert.ok(html.includes("tce-load -w ca-certificates.tcz"));
  assert.ok(html.includes("tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1; install_rc=$?"));
  assert.ok(html.includes("openssl version >/dev/null 2>&1"));
  assert.ok(html.includes("tce-load -i ca-certificates >/tmp/ca-certificates-install.log 2>&1; ca_ir=$?"));
  assert.ok(html.includes("CA_BUNDLE_PATH=$CA_BUNDLE"));
  assert.ok(html.includes("/tmp/ca-certificates-bundle.pem"));
  const caCommand = html.match(/`echo "--- CA certificate install ---";([\s\S]*?)`,/);
  assert.ok(caCommand, "CA install command should be present");
  assert.ok(caCommand[0].length < 900, "CA install command must stay short enough to avoid terminal input truncation");
  assert.ok(html.includes("CA_INSTALL_RC=$ca_ir"));
  assert.ok(html.includes("CA_BUNDLE_PATH=$CA_BUNDLE"));
  assert.ok(!html.includes("tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1 &"));
  assert.ok(!html.includes("tce-load -i ca-certificates >/tmp/ca-certificates-install.log 2>&1 &"));
  assert.ok(html.indexOf("tce-load -i openssl-1.1.1") < html.indexOf("tce-load -i ca-certificates"));
  assert.ok(html.indexOf("tce-load -i ca-certificates") < html.indexOf("${apiUrl}/health"));
});

test("bootstrap waits for a fresh completion marker and a shell prompt before advancing", () => {
  assert.ok(html.includes("function markerCount(text,marker)"));
  assert.ok(html.includes("markerCount(t,marker)>markerCountBefore"));
  assert.ok(html.includes("shellPrompt(t.slice(markerAt+marker.length))"));
  assert.ok(html.includes("const markerCountBefore=marker?markerCount(terminal(),marker):0"));
  assert.ok(html.includes("requestAnimationFrame(wait)"));
});

test("VM snapshot save is attempted after the post-boot test sequence", () => {
  assert.ok(html.includes("const saved=await saveVmState(false)"));
  assert.ok(html.includes("Startup and network tests complete; VM state saved."));
  assert.ok(html.includes("Startup complete; VM state save did not complete."));
});

test("VM downloads active diagnostic scripts from same-origin Worker assets", () => {
  assert.ok(html.includes("${apiUrl}/health"), "HTTPS preflight should test the deployed Worker health endpoint");
  for (const asset of ["network-test.sh", "fineproxy-test.sh"]) {
    assert.ok(html.includes("${apiUrl}/runner/tinycore/" + asset), "VM should download " + asset + " from Worker assets");
  }
  assert.ok(!html.includes("browser-bootstrap.sh"), "paused Mysterium bootstrap must not be downloaded or launched by VM startup");
  assert.ok(!html.includes("raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking"));
  assert.ok(bootstrap.includes("Mysterium bootstrap is temporarily disabled."));
  assert.ok(!bootstrap.includes("wget "));
  assert.ok(!bootstrap.includes("/opt/mysterium/myst"));
});

test("startup intentionally has no command or network timeouts", () => {
  assert.ok(!html.includes("setTimeout("), "startup must not use JavaScript timeouts");
  assert.ok(!html.includes("BOOT_TIMEOUT_MS"));
  assert.ok(!html.includes("wget -T "));
  assert.ok(!/udhcpc[^\n]*\s-t\s*[0-9]/.test(html), "DHCP should not have a retry-count timeout");
  assert.ok(html.includes("until wget -S -O /dev/null ${apiUrl}/health"));
  assert.ok(html.includes("sleep 2"));
});
