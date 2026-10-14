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
  for (const marker of [
    'printf "\\n__OPENSSL_DONE:%s\\n"',
    'printf "\\n__CA_CERTIFICATES_STARTED:0\\n"',
    'printf "\\n__EGRESS_PREFLIGHT_%s:%s\\n"',
    'printf "\\n__BOOTSTRAP_DOWNLOAD_%s:%s\\n"',
    'printf \\"\\n__BOOTSTRAP_RUN_%s:%s\\n\\"',
    'printf \\"\\n__SUPERVISOR_%s\\n\\"',
    'printf \\"\\n__RUNNER_%s\\n\\"',
    'printf \\"\\n__NETWORK_TEST_%s:%s\\n\\"',
    'printf \\"\\n__FINEPROXY_TEST_%s:%s\\n\\"',
  ]) {
    assert.ok(html.includes(marker), "expected newline-delimited marker command: " + marker);
  }
});

test("CA certificates are downloaded before HTTPS preflight and initialized afterward", () => {
  assert.ok(html.includes("tce-load -w ca-certificates.tcz"));
  assert.ok(html.includes("tce-load -wil ca-certificates.tcz && sh /tmp/cloudflare-browser-bootstrap.sh"));
  assert.ok(html.includes("__CA_CERTIFICATES_DOWNLOAD_%s:%s"));
  assert.ok(!html.includes("__CA_CERTIFICATES_STARTED:"));
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


test("VM snapshots use the authenticated account and a separate IndexedDB store", () => {
  assert.ok(html.includes("fetch('/api/auth/session'"), "snapshot identity must come from the authenticated Worker session");
  assert.ok(html.includes("snapshotKey=session.username+':'+nodeId"), "snapshots must be scoped to account and node");
  assert.ok(html.includes("indexedDB.open(SNAPSHOT_DB_NAME,1)"), "snapshot data must be stored in IndexedDB");
  assert.ok(html.includes("await window.emulator.save_state()"), "snapshot export must use the promise-based v86 API");
  assert.ok(html.includes("await window.emulator.restore_state(state)"), "snapshot restore must use the promise-based v86 API");
  assert.ok(html.includes("saveVmSnapshot('periodic checkpoint')"), "VM should periodically checkpoint state");
  assert.ok(html.includes("saveVmSnapshot('dashboard pause')"), "dashboard pause should trigger a snapshot");
  assert.ok(html.includes("autostart:false"), "VM must wait until snapshot restoration is attempted before running");
});

test("Worker exposes account identity only for a valid dashboard session", () => {
  const worker = readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
  const route = worker.match(/if \(url\.pathname === "\/api\/auth\/session"\) \{[\s\S]*?\n    \}/);
  assert.ok(route, "authenticated session identity route should exist");
  assert.ok(route[0].includes("authStore(env, \"/auth/session?token=\""), "route must validate the HttpOnly session with the Durable Object");
  assert.ok(route[0].includes("return json({ username: session.username"), "route should return account identity, not the session token");
  assert.ok(route[0].includes("if (!match) return json({ error: \"dashboard_access_required\" }, 401)"), "route must reject missing session cookies");
});
