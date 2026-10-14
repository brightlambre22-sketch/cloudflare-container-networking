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
    'printf "\\n__RESOURCE_PREFLIGHT_DONE\\n"',
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

test("bootstrap does not gate startup on installing the OpenSSL extension", () => {
  assert.ok(html.includes("OPENSSL_PACKAGE_INSTALL=SKIPPED"));
  assert.ok(html.includes("__RESOURCE_PREFLIGHT_DONE"));
  assert.ok(!html.includes("tce-load -wil openssl-1.1.1.tcz"));
  assert.ok(!html.includes("__OPENSSL_DONE:"));
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
