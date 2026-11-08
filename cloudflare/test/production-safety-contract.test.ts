import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { baselineIsReady } from "../src/snapshot-readiness.ts";
import { handleDoorDashRequest } from "../src/doordash.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

const readyBaseline = {
  version: 1,
  generation: "baseline-1",
  chunks: 1,
  byteLength: 16,
  adminReady: true,
  checks: {
    guest_booted: true,
    shell_command_passed: true,
    dhcp_passed: true,
    ca_certificates_passed: true,
  },
};

test("merchant provisioner accepts only a fully ready Admin baseline", () => {
  assert.equal(baselineIsReady(readyBaseline), true);
  assert.equal(baselineIsReady({ ...readyBaseline, adminReady: false }), false);
  assert.equal(baselineIsReady({
    ...readyBaseline,
    checks: { ...readyBaseline.checks, ca_certificates_passed: false },
  }), false);
  assert.equal(baselineIsReady({
    ...readyBaseline,
    checks: { ...readyBaseline.checks, dhcp_passed: false },
  }), false);
});

test("Admin baseline uploads enforce the same readiness contract", async () => {
  const worker = await source("../src/index.ts");
  assert.match(worker, /identity === \(env\.VM_BASELINE_ID \?\? "admin"\)/);
  assert.match(worker, /baselineIsReady\(manifest as BaselineManifest\)/);
  assert.match(worker, /required_checks:[\s\S]*"ca_certificates_passed"/);
  assert.match(worker, /admin_baseline_not_ready/);
});

test("root homepage explicitly resolves public/index.html", async () => {
  const worker = await source("../src/index.ts");
  assert.match(worker, /url\.pathname === "\/" \|\| url\.pathname === "\/index\.html"/);
  assert.match(worker, /assetUrl\.pathname = "\/index\.html"/);
  assert.match(worker, /env\.ASSETS\.fetch\(new Request\(assetUrl, request\)\)/);
});

test("production diagnostics require the administrator bearer key", async () => {
  const worker = await source("../src/index.ts");
  for (const route of ["/debug/egress-ip", "/debug/fineproxy-tcp"]) {
    const index = worker.indexOf('if (url.pathname === "' + route + '")');
    assert.notEqual(index, -1, `Missing diagnostic route ${route}`);
    const block = worker.slice(index, index + 300);
    assert.match(block, /authorized\(request\.headers\.get\("authorization"\), env\.ADMIN_ACCESS_KEY\)/);
  }
});

test("DoorDash production mode stays disabled until production credentials exist", async () => {
  const request = new Request(
    "https://vampirequid.example/api/delivery/quote/123e4567-e89b-12d3-a456-426614174000",
    { method: "POST" },
  );
  const response = await handleDoorDashRequest(request, {
    PROJECT_STORAGE: {} as R2Bucket,
    DOORDASH_ENVIRONMENT: "production",
  });
  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { error: "doordash_credentials_not_configured" });
});
