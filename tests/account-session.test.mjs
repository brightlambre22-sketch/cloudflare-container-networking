import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(new URL("../cloudflare/src/account-registry.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const stockroom = readFileSync(new URL("../cloudflare/src/business-database.ts", import.meta.url), "utf8");

test("signup stores server-side PBKDF2 credentials and enforces eight-character passwords", () => {
  assert.match(registry, /PBKDF2/);
  assert.match(registry, /iterations: 100000/);
  assert.match(registry, /auth-user:/);
  assert.match(registry, /username_unavailable/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/signup"/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login"/);
  assert.match(worker, /password\.length < 8/);
  assert.match(registry, /password\.length < 8/);
  assert.match(dashboard, /pass\.length<8/);
  assert.match(dashboard, /at least 8 characters/);
  assert.match(worker, /snapshot_cloned: false/);
});

test("signup provisions an isolated Stockroom and queues snapshot cloning", () => {
  const start = worker.indexOf('if (url.pathname === "/api/auth/signup"');
  const end = worker.indexOf('if (url.pathname === "/api/auth/login"', start);
  assert.ok(start >= 0 && end > start, "signup route should be present");
  const signup = worker.slice(start, end);
  assert.match(signup, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(signup, /api_key_sha256:\s*apiKeyHash/);
  assert.match(signup, /businessDatabaseFetch\(env, accountId, "initialize"/);
  assert.match(signup, /ACCOUNT_PROVISIONER\.get\(env\.ACCOUNT_PROVISIONER\.idFromName\(accountId\)\)/);
  assert.match(signup, /progress_endpoint: "\/api\/auth\/registration-status"/);
  assert.match(stockroom, /BUSINESS_DATABASE\.idFromName\(accountId\)/);
});

test("sessions expire and are bound to the account ID for every snapshot operation", () => {
  assert.match(registry, /auth-session:/);
  assert.match(registry, /session\.account_id !== body\.account_id/);
  assert.match(registry, /session\.expires_at <= Date\.now\(\)/);
  assert.match(worker, /auth\/verify/);
  assert.match(worker, /accountAuthorized/);
  assert.match(dashboard, /headers\.authorization='Bearer '\+window\.snapshotAuthToken/);
});

test("missing or unreadable account snapshots fail closed instead of booting a fresh account VM", () => {
  assert.match(dashboard, /No saved VM snapshot exists for this account; refusing to boot a fresh VM over missing user data/);
  assert.match(dashboard, /snapshotLoadFailed=true/);
  assert.match(dashboard, /Snapshot load failed; refusing to overwrite server state/);
  assert.match(dashboard, /Restore failed; no fresh bootstrap started/);
  assert.match(dashboard, /Account snapshot restore failed; stopped without starting a fresh VM/);
});

test("public auth routes are rate-limited and browser credentials are not persisted in localStorage", () => {
  assert.match(registry, /auth-rate:/);
  assert.match(registry, /body\.action === "signup" \? 5 : 10/);
  assert.match(worker, /auth\/rate-limit/);
  assert.match(dashboard, /sessionStorage\.setItem\('vm-session-token'/);
  assert.doesNotMatch(dashboard, /localStorage\.setItem\(ACCOUNTS_KEY/);
  assert.match(dashboard, /mysterium-network-test-results:/);
});

test("restored VMs automatically test the network and save after the test returns to a prompt", () => {
  assert.match(dashboard, /runDiagnostic\('AUTOMATIC NETWORK TEST AFTER SNAPSHOT RESTORE',true\)/);
  assert.match(dashboard, /if\(saveAfter&&bootComplete\)/);
  assert.match(dashboard, /const saved=await saveVmState\(false\)/);
});
