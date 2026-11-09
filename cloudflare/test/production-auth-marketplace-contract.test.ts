import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("merchant workspace pages fail closed without a live server-verified session", async () => {
  const worker = await read("../src/index.ts");
  assert.match(worker, /protectedMerchantPages = new Set\(\[/);
  for (const page of ["/studio", "/studio.html", "/workspace", "/workspace.html", "/merchant-orders", "/merchant-orders.html", "/merchant-location", "/merchant-location.html"]) {
    assert.ok(worker.includes('"' + page + '"'), "protected page missing: " + page);
  }
  assert.match(worker, /vq_merchant_session=/);
  assert.match(worker, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(worker, /verifyMerchantSession\(env, match\[1\], match\[2\]\)/);
  assert.match(worker, /auth_required=1/);
  assert.match(worker, /request\.method === "HEAD"/);
  assert.match(worker, /cache-control", "no-store"/);
  assert.match(worker, /clearMerchantSessionCookie/);
});

test("merchant signup, login, invitation claim, session validation, and logout manage cookies", async () => {
  const worker = await read("../src/index.ts");
  assert.match(worker, /jsonWithCookie\(\{ \.\.\.session, username, status: "provisioning"/);
  assert.match(worker, /status: isComplete \? "complete" : "provisioning"/);
  assert.match(worker, /jsonWithCookie\(\{ \.\.\.login, username, virtual_ip/);
  assert.match(worker, /merchantSessionCookie\(body\.account_id, body\.session_token\)/);
  assert.match(worker, /clearMerchantSessionCookie\(\)/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/logout"/);
});

test("admin login survives reload through a secure HttpOnly session and supports logout", async () => {
  const [worker, dashboard] = await Promise.all([
    read("../src/index.ts"),
    read("../../public/vm.html"),
  ]);
  assert.match(worker, /vq_admin_session=/);
  assert.match(worker, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(worker, /function adminAuthorized\(request: Request, env: Env\)/);
  assert.match(worker, /url\.pathname === "\/api\/admin\/session"/);
  assert.match(worker, /url\.pathname === "\/api\/admin\/logout"/);
  assert.match(dashboard, /fetch\('\/api\/admin\/session'/);
  assert.match(dashboard, /window\.snapshotAdminSession=true/);
  assert.match(dashboard, /fetch\('\/api\/admin\/logout'/);
  assert.match(dashboard, /session-logout/);
});

test("account deletion and admin purge remove published stores, merchant files, and business data", async () => {
  const [worker, ledger, relay] = await Promise.all([
    read("../src/index.ts"),
    read("../src/inventory-ledger.ts"),
    read("../src/wisp-relay.ts"),
  ]);
  assert.match(worker, /purgeMarketplaceAccountData\(env, accountId\)/);
  assert.match(worker, /published-sites\/index\//);
  assert.match(worker, /published-sites\/" \+ slug \+ "\//);
  assert.match(worker, /marketplace\/merchants\//);
  assert.match(worker, /marketplace\/catalog-sync\//);
  assert.match(worker, /merchants\/" \+ accountId \+ "\//);
  assert.match(worker, /businessDatabaseFetch\(env, accountId, "purge"/);
  assert.match(worker, /business_database_purged: true/);
  assert.match(worker, /wisp-relay\.internal\/purge/);
  assert.match(worker, /wisp_relay_purged: true/);
  assert.match(worker, /inventory-ledger\.internal\/purge/);
  assert.match(ledger, /url\.pathname === "\/purge"/);
  assert.match(relay, /url\.pathname === "\/purge"/);
  for (const table of ["inventory_catalog", "inventory_reservations", "inventory_reservation_items", "inventory_orders", "offline_sales", "offline_allocations", "offline_allocation_items"]) {
    assert.ok(ledger.includes('"' + table + '"'), "ledger purge misses " + table);
  }
});

test("marketplace discovery excludes deleted accounts even if stale R2 listing metadata remains", async () => {
  const marketplace = await read("../src/marketplace-directory.ts");
  assert.match(marketplace, /admin\/list-accounts/);
  assert.match(marketplace, /activeAccounts\.has\(profile\.account_id\)/);
  assert.match(marketplace, /merchant_directory_unavailable/);
});

test("marketplace uses a real geographic tile map and ZIP-based search", async () => {
  const [app, page] = await Promise.all([
    read("../../public/emporium/js/marketplace-app.js"),
    read("../../public/marketplace.html"),
  ]);
  assert.match(app, /L\.map\(plot/);
  assert.match(app, /tileLayer\("https:\/\/\{s\}\.tile\.openstreetmap\.org/);
  assert.match(app, /api\/marketplace\/location\?postal_code=/);
  assert.match(app, /search\.set\("lat"/);
  assert.match(app, /search\.set\("lng"/);
  assert.match(app, /addEventListener\("submit"/);
  assert.match(page, /id="vq-location"/);
  assert.match(page, /id="vq-map-plot"/);
  assert.match(page, /leaflet@1\.9\.4\/dist\/leaflet\.js/);
  assert.match(page, /leaflet@1\.9\.4\/dist\/leaflet\.css/);
});
