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
  assert.ok(html.includes("CA_INSTALLED_FILE=$f"));
  assert.ok(html.includes("CA_INSTALLED_FILE_COUNT=$new_count"));
  assert.ok(html.includes("/usr/local/share/ca-certificates/mozilla/*.crt"));
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
