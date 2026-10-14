import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../public/runner/tinycore/browser-bootstrap.sh", import.meta.url), "utf8");
const worker = readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

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

test("bootstrap completion markers match the current staged startup flow", () => {
  for (const marker of [
    "__OPENSSL_DONE:%s",
    "__CA_CERTIFICATES_DOWNLOAD_%s:%s",
    "__BOOTSTRAP_DOWNLOAD_%s:%s",
    "__BOOTSTRAP_RUN_%s:%s",
    "__BOOTSTRAP_VERIFY_%s:%s",
    "__SUPERVISOR_%s",
    "__RUNNER_%s",
  ]) {
    assert.ok(html.includes(marker), "expected bootstrap marker: " + marker);
  }
  assert.ok(html.includes("DHCP_DONE"));
});

test("CA certificates are downloaded before bootstrap and installed before runner setup", () => {
  assert.ok(html.includes("tce-load -w ca-certificates.tcz"));
  assert.ok(html.includes("tce-load -wil ca-certificates.tcz && sh /tmp/cloudflare-browser-bootstrap.sh"));
  assert.ok(html.includes("__CA_CERTIFICATES_DOWNLOAD_%s:%s"));
  assert.ok(!html.includes("__CA_CERTIFICATES_STARTED:"));
});

test("VM keeps network diagnostics manual and downloads assets from the Worker origin", () => {
  assert.ok(html.includes("run-network-test"), "manual network test control should remain");
  assert.ok(html.includes("${apiUrl}/runner/tinycore/network-test.sh"), "manual diagnostics should use same-origin assets");
  assert.ok(!html.includes("${apiUrl}/health"), "the latest startup flow intentionally has no automatic health preflight");
  assert.ok(!html.includes("raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking"), "VM must not fetch private repository files from unauthenticated raw GitHub");
  assert.ok(bootstrap.includes('RAW_BASE="${API_URL%/}/runner/tinycore"'), "bootstrap helper downloads should use the Worker asset origin");
  assert.ok(!bootstrap.includes("raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking"), "bootstrap must not fetch helper scripts from private raw GitHub");
});

test("VM snapshots require a valid v86 state header", () => {
  const normalizer = html.match(/function normalizeStateBuffer\(state\)\s*\{[\s\S]*?\n\}/);
  const validator = html.match(/function isV86State\(state\)\s*\{[\s\S]*?\n\}/);
  assert.ok(normalizer && validator, "snapshot normalization and validation helpers should exist");
  const checks = vm.runInNewContext("(()=>{" + normalizer[0] + ";" + validator[0] + ";const state=new ArrayBuffer(24),view=new DataView(state);view.setInt32(0,-2039052682,true);view.setInt32(4,6,true);view.setInt32(8,24,true);const valid=isV86State(state);view.setInt32(4,99,true);return {valid,invalid:isV86State(state)};})()");
  assert.equal(checks.valid, true);
  assert.equal(checks.invalid, false);
});

test("VM restore is tied to an authenticated account and logout waits for a save attempt", () => {
  assert.ok(worker.includes('url.pathname === "/api/auth/session"'), "Worker should expose the current authenticated account");
  assert.ok(html.includes("fetch('/api/auth/session'"), "VM should bind the local snapshot to the login session");
  assert.ok(html.includes("indexedDB.open('myst-v86-state'"), "large binary VM states should use IndexedDB");
  assert.ok(html.includes("window.emulator.save_state()"), "VM should save a v86 snapshot");
  assert.ok(html.includes("window.emulator.restore_state(initialVmState)"), "VM should restore a saved snapshot");
  assert.ok(html.includes("bootstrapFinished=true"), "restore should not rerun the completed bootstrap");
  assert.ok(dashboard.includes("type:'vm-save-state'"), "logout should request a final snapshot before clearing the session");
});
