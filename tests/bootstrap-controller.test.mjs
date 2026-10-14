import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");

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
    'printf "\\n__PACKAGES_READY_DONE:%s\\n"',
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
