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

test("completion markers are emitted on their own lines", () => {
  for (const marker of ["__RESOURCE_PREFLIGHT_DONE", "__TLS_DOWNLOAD_DONE:", "__OPENSSL_INSTALL_DONE:", "__CA_CERTIFICATES_INSTALL_DONE:", "__EGRESS_PREFLIGHT_%s:%s", "__BOOTSTRAP_DOWNLOAD_%s:%s", "__BOOTSTRAP_RUN_%s:%s", "__SUPERVISOR_%s", "__RUNNER_%s", "__NETWORK_TEST_%s:%s", "__FINEPROXY_TEST_%s:%s"]) {
    assert.ok(html.includes(marker), "expected completion marker: " + marker);
  }
});

test("TLS installs run in the background and gate HTTPS on actual files", () => {
  assert.ok(html.includes("tce-load -w openssl-1.1.1.tcz"));
  assert.ok(html.includes("tce-load -w ca-certificates.tcz"));
  assert.ok(html.includes("tce-load -i openssl-1.1.1 >/tmp/openssl-install.log 2>&1 &"));
  assert.ok(html.includes("openssl version >/dev/null 2>&1"));
  assert.ok(html.includes('kill -0 "$op" 2>/dev/null'));
  assert.ok(html.includes('kill -0 "$cp" 2>/dev/null'));
  assert.ok(html.includes("tce-load -i ca-certificates >/tmp/ca-certificates-install.log 2>&1 &"));
  assert.ok(html.includes("/usr/local/etc/ssl/certs/ca-certificate"));
  assert.ok(html.indexOf("tce-load -i openssl-1.1.1") < html.indexOf("tce-load -i ca-certificates"));
  assert.ok(html.indexOf("tce-load -i ca-certificates") < html.indexOf("${apiUrl}/health"));
});

test("bootstrap waits for fresh markers and the shell prompt before sending the next command", () => {
  assert.ok(html.includes("function markerCount(text,marker)"));
  assert.ok(html.includes("markerCount(t,marker)>markerCountBefore"));
  assert.ok(html.includes("shellPrompt(t.slice(markerAt+marker.length))"));
  assert.ok(html.includes("markerCount(t,pm)>markerCountBefore"));
  assert.ok(html.includes("shellPrompt(t.slice(markerAt+pm.length))"));
});

test("VM snapshot is saved after the post-boot test sequence", () => {
  assert.ok(html.includes("const saved=await saveVmState(false)"));
  assert.ok(html.includes("VM state saved locally."));
});
test("VM bootstrap downloads use same-origin public Worker assets, not private raw GitHub URLs", () => {
  assert.ok(html.includes("${apiUrl}/health"), "HTTPS preflight should test the deployed Worker health endpoint");
  for (const asset of ["browser-bootstrap.sh", "network-test.sh", "fineproxy-test.sh"]) {
    assert.ok(html.includes("${apiUrl}/runner/tinycore/" + asset), "VM should download " + asset + " from Worker assets");
  }
  assert.ok(!html.includes("raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking"), "VM must not fetch private repository files from unauthenticated raw GitHub");
  assert.ok(bootstrap.includes('RAW_BASE="${API_URL%/}/runner/tinycore"'), "bootstrap helper downloads should use the Worker asset origin");
  assert.ok(!bootstrap.includes("raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking"), "bootstrap must not fetch helper scripts from private raw GitHub");
});
