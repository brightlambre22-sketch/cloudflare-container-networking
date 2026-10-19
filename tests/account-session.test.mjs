import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(new URL("../cloudflare/src/account-registry.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");

test("signup stores server-side PBKDF2 credentials and enforces unique usernames", () => {
  assert.match(registry, /PBKDF2/);
  assert.match(registry, /iterations: 100000/);
  assert.match(registry, /auth-user:/);
  assert.match(registry, /username_unavailable/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/signup"/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login"/);
  assert.doesNotMatch(dashboard, /vm-test-accounts-v1|function readAccounts\(\)/);
  assert.match(worker, /password\.length < 4/);
  assert.match(registry, /password\.length < 4/);
  assert.match(dashboard, /if\(creating&&pass\.length<4\)/);
  assert.match(worker, /snapshot_cloned: true/);
  assert.doesNotMatch(worker.slice(worker.indexOf('if (url.pathname === "\/api\/auth\/signup"'), worker.indexOf('if (url.pathname === "\/api\/auth\/login"')), /snapshot_initialization_required: true/);
  assert.match(dashboard, /snapshot_initialization_required===true/);
});

test("sessions expire and are bound to the account ID for every snapshot operation", () => {
  assert.match(registry, /auth-session:/);
  assert.match(registry, /session\.account_id !== body\.account_id/);
  assert.match(registry, /session\.expires_at <= Date\.now\(\)/);
  assert.match(worker, /auth\/verify/);
  assert.match(worker, /accountAuthorized/);
  assert.match(dashboard, /headers\.authorization='Bearer '\+window\.snapshotAuthToken/);
});

test("signup clones a ready Admin baseline without booting Linux", () => {
  assert.match(worker, /const baselineId = env\.VM_BASELINE_ID \?\? "admin"/);
  assert.match(worker, /admin_baseline_not_ready/);
  assert.match(worker, /snapshot_cloned: true/);
  const signup = worker.slice(worker.indexOf('if (url.pathname === "\/api\/auth\/signup"'), worker.indexOf('if (url.pathname === "\/api\/auth\/login"'));
  assert.match(signup, /baselineGeneration/);
  assert.doesNotMatch(signup, /ACCOUNT_PROVISIONER|headlessV86Roundtrip|snapshot_initialization_required: true/);
  assert.match(dashboard, /vm-initial-snapshot-pending/);
  assert.match(dashboard, /if\(saveAfter&&bootComplete\)/);
  assert.match(dashboard, /window\.snapshotNeedsInitialSave=false/);
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
  assert.match(registry, /body\.action === "signup" \? 500 : 2000/);
  assert.match(worker, /auth\/rate-limit/);
  assert.match(dashboard, /sessionStorage\.setItem\('vm-session-token'/);
  assert.doesNotMatch(dashboard, /localStorage\.setItem\(ACCOUNTS_KEY/);
  assert.match(dashboard, /mysterium-network-test-results:\x27\+\(window\.snapshotIdentity\|\|\x27admin\x27\)/);
});

test("restored VMs automatically test the network and save after the test returns to a prompt", () => {
  assert.match(dashboard, /runDiagnostic\('AUTOMATIC NETWORK TEST AFTER SNAPSHOT RESTORE',true\)/);
  assert.match(dashboard, /if\(saveAfter&&bootComplete\)/);
  assert.match(dashboard, /const saved=await saveVmState\(false\)/);
});
