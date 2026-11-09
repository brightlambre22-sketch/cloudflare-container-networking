import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(new URL("../cloudflare/src/account-registry.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");
const stockroom = readFileSync(new URL("../cloudflare/src/business-database.ts", import.meta.url), "utf8");
const wispRelay = readFileSync(new URL("../cloudflare/src/wisp-relay.ts", import.meta.url), "utf8");
const virtualNetwork = readFileSync(new URL("../cloudflare/src/virtual-network.ts", import.meta.url), "utf8");
const headlessRoundtrip = readFileSync(new URL("../cloudflare/src/headless-v86-snapshot-roundtrip-worker.ts", import.meta.url), "utf8");
const headlessRoundtripConfig = readFileSync(new URL("../cloudflare/wrangler.headless-v86-roundtrip.toml", import.meta.url), "utf8");
const marketplace = readFileSync(new URL("../cloudflare/src/marketplace-directory.ts", import.meta.url), "utf8");
const merchantLocation = readFileSync(new URL("../public/merchant-location.html", import.meta.url), "utf8");

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

test("each merchant receives a stable private network identity and authenticated WISP relay", () => {
  assert.ok(virtualNetwork.includes("first_allocatable_ordinal: 1"));
  assert.ok(virtualNetwork.includes("last_allocatable_ordinal: 64767"));
  assert.ok(virtualNetwork.includes("virtualIpForOrdinal"));
  assert.ok(virtualNetwork.includes("virtualGatewayForIp"));
  assert.ok(registry.includes("/network/allocate"));
  assert.ok(registry.includes("storage.transaction"));
  assert.ok(registry.includes("networkIdentityMatch"));
  assert.ok(worker.includes("WISP_RELAY"));
  assert.ok(worker.includes("/api/network/ticket"));
  assert.ok(worker.includes("/api/network/wisp"));
  assert.ok(worker.includes("virtual_ip: identity.virtual_ip"));
  assert.ok(wispRelay.includes("active-ticket"));
  assert.ok(wispRelay.includes("record.ticket !== ticket"));
  assert.ok(wispRelay.includes("connect({ hostname: host, port })"));
  assert.ok(wispRelay.includes("port !== 80 && port !== 443"));
  assert.ok(wispRelay.includes("INITIAL_BUFFER"));
  assert.ok(dashboard.includes("vm_ip:virtualIp"));
  assert.ok(dashboard.includes("router_ip:routerIp"));
  assert.ok(dashboard.includes("/api/network/ticket"));
  assert.ok(dashboard.includes("/api/network/wisp/"));
  assert.ok(!dashboard.includes("relay.widgetry.org"));
  assert.ok(headlessRoundtrip.includes("vm_ip: virtualIp"));
  assert.ok(headlessRoundtrip.includes("router_ip: routerIp"));
  assert.ok(headlessRoundtrip.includes("/api/network/wisp/"));
  assert.ok(!headlessRoundtrip.includes("relay.widgetry.org"));
  assert.ok(headlessRoundtripConfig.includes('name = "WISP_RELAY"'));
});

test("published Store projects remain discoverable across legacy casing and require owner-matched publish records", () => {
  assert.ok(marketplace.includes('project.kind.trim().toLowerCase()'));
  assert.ok(marketplace.includes('projectKind !== "store"'));
  assert.ok(marketplace.includes('mapping?.account_id !== accountId || mapping.project_id !== project.id'));
  assert.ok(marketplace.includes('url.pathname === "/api/marketplace/profile"'));
  assert.ok(marketplace.includes('url.pathname === "/api/marketplace/geocode"'));
  assert.ok(marketplace.includes('env.PROJECT_STORAGE'));
  assert.ok(merchantLocation.includes('/api/marketplace/profile?account_id='));
  assert.ok(merchantLocation.includes('/api/marketplace/geocode?account_id='));
  assert.ok(merchantLocation.includes('Find address on map'));
  assert.ok(merchantLocation.includes('latitude:coordinates.latitude,longitude:coordinates.longitude'));
});

test("the current Vampirequid workspace branding, account settings, and VM controls are present", () => {
  assert.ok(dashboard.includes('href="/vampiresquid-mark.svg"'));
  assert.ok(dashboard.includes('<img src="/vampiresquid-mark.svg"'));
  assert.ok(dashboard.includes("window.startVm()"));
  for (const id of ["save-vm-state", "clear-vm-state", "run-bootstrap", "paste-terminal", "copy-results", "api-key-generate", "account-id-value", "screen_container"]) {
    assert.ok(dashboard.includes('id="' + id + '"'), "workspace control should remain: " + id);
  }
  assert.ok(dashboard.includes("Optional external POS integration key"));
  assert.ok(dashboard.includes("Replace API key"));
  assert.ok(dashboard.includes("Account ID"));
  assert.ok(!dashboard.includes("Use at least 4 characters for the password"));
});

test("the Cloudflare deployment retains the original runtime feature flags", () => {
  const config = readFileSync(new URL("../cloudflare/wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /ORACLE_ACCOUNT_EXEC_ENABLED\s*=\s*"true"/);
  assert.match(config, /DOORDASH_ENVIRONMENT\s*=\s*"sandbox"/);
});
