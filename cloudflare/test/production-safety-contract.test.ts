import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handleDoorDashRequest } from "../src/doordash.ts";

const source = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("snapshot manifests satisfy the merchant provisioner readiness contract", async () => {
  const [snapshot, provisioner] = await Promise.all([
    source("../src/headless-snapshot-store.ts"),
    source("../src/account-provisioner.ts"),
  ]);
  assert.match(snapshot, /adminReady: true/);
  assert.match(snapshot, /ca_certificates_passed: true/);
  assert.match(provisioner, /value\.adminReady === true/);
  assert.match(provisioner, /checks!\.ca_certificates_passed === true/);
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
    const escaped = route.replaceAll("/", "\\/");
    const index = worker.indexOf('if (url.pathname === "' + route + '")');
    assert.notEqual(index, -1, `Missing diagnostic route ${route}`);
    const block = worker.slice(index, index + 300);
    assert.match(block, /authorized\(request\.headers\.get\("authorization"\), env\.ADMIN_ACCESS_KEY\)/);
  }
});

test("DoorDash production mode reaches credential validation without enabling itself", async () => {
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
