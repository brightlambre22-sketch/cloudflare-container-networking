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
  assert.match(worker, /cache-control.*no-store/);
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
  assert.match(worker, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/, "admin browser sessions must use high-entropy random tokens");
  assert.match(worker, /admin\/session\/create/);
  assert.match(worker, /admin\/session\/verify/);
  assert.match(worker, /admin\/session\/revoke/);
  assert.match(worker, /adminSessionCookie\(token\)/, "the cookie must contain the opaque session token, not the master key");
  assert.doesNotMatch(worker, /adminSessionCookie\(body\.key/);
  assert.match(worker, /await adminAuthorized\(request, env\)/, "every route guard must await session verification");

  assert.match(worker, /url\.pathname === "\/api\/admin\/session"/);
  assert.match(worker, /url\.pathname === "\/api\/admin\/logout"/);
  assert.match(dashboard, /fetch\('\/api\/admin\/session'/);
  assert.match(dashboard, /window\.snapshotAdminSession=true/);
  assert.match(dashboard, /fetch\('\/api\/admin\/logout'/);
  assert.match(dashboard, /session-logout/);
  assert.doesNotMatch(dashboard, /snapshotAdminKey=adminKeyValue/, "the master admin key must not remain in browser JavaScript state");
  assert.match(dashboard, /adminKey\.value=\x27\x27/, "clear the password field after session creation");
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
  assert.match(marketplace, /api\.zippopotam\.us\/us\//);
  assert.match(marketplace, /AbortSignal\.timeout\(6000\)/);
  assert.match(marketplace, /AbortSignal\.timeout\(8000\)/);
  assert.match(marketplace, /geocodePostalCode/);
});

test("marketplace uses a real geographic tile map and ZIP-based search", async () => {
  const [app, page] = await Promise.all([
    read("../../public/emporium/js/marketplace-app.js"),
    read("../../public/marketplace.html"),
  ]);
  assert.match(app, /new window\.maplibregl\.Map\(/);
  assert.match(app, /https:\/\/tiles\.openfreemap\.org\/styles\/liberty/);
  assert.match(app, /new window\.maplibregl\.Marker/);
  assert.match(app, /Visit store page/);
  assert.match(app, /Open Street View/);
  assert.doesNotMatch(app, /L\.map\(plot|tileLayer\(/, "marketplace map must not initialize Leaflet or raster tile layers");
  assert.doesNotMatch(app, /basemaps\.cartocdn\.com|carto\.com\/attributions/i, "marketplace map must not request CARTO or an API key");
  assert.match(app, /api\/marketplace\/location\?postal_code=/);
  assert.match(app, /search\.set\("lat"/);
  assert.match(app, /search\.set\("lng"/);
  assert.match(app, /addEventListener\("submit"/);
  assert.match(page, /id="vq-location"/);
  assert.match(page, /id="vq-map-plot"/);
  assert.match(page, /maplibre-gl@4\.7\.1\/dist\/maplibre-gl\.js/);
  assert.match(page, /maplibre-gl@4\.7\.1\/dist\/maplibre-gl\.css/);
});


test("deleting a published Store project unpublishes its site and removes its marketplace listing", async () => {
  const storage = await read("../src/project-storage.ts");
  assert.match(storage, /if \(request\.method === "DELETE"\)[\s\S]*?existingProject/);
  assert.match(storage, /published-sites\/index\//);
  assert.match(storage, /published-sites\/" \+ publishedSlug \+ "\//);
  assert.match(storage, /mapping\.account_id === accountId && mapping\.project_id === projectId/);
  assert.match(storage, /marketplace\/merchants\/" \+ accountId \+ "\.json/);
  assert.match(storage, /profile\.project_id === projectId/);
  assert.match(storage, /marketplace_listing_removed: true/);
});

test("coordinate-based marketplace searches never include stores outside the selected radius", async () => {
  const marketplace = await read("../src/marketplace-directory.ts");
  assert.match(marketplace, /if \(distance !== null && distance > radius\) continue/);
  assert.doesNotMatch(marketplace, /distance > radius && !postalMatch/);
  assert.match(marketplace, /distance_miles: distance === null \? null : Number\(distance\.toFixed\(1\)\)/);
});


test("merchant marketplace settings can geocode the entered physical shop address", async () => {
  const [page, app] = await Promise.all([
    read("../../public/studio.html"),
    read("../../public/studio.js"),
  ]);
  assert.match(page, /id="marketplace-geocode"/);
  assert.match(page, /Find shop coordinates from address/);
  assert.match(app, /async function geocodeMarketplaceAddress\(\)/);
  assert.match(app, /api\/marketplace\/geocode\?account_id=/);
  assert.match(app, /const lat=Number\(data\.latitude\),lng=Number\(data\.longitude\)/);
  assert.match(app, /#marketplace-latitude'\)\.value=lat\.toFixed\(7\)/);
  assert.match(app, /#marketplace-longitude'\)\.value=lng\.toFixed\(7\)/);
  assert.match(app, /function marketplaceAddressKey\(\)/);
  assert.match(app, /function clearMarketplaceCoordinates\(message=/);
  assert.match(app, /function showMarketplaceMap\(latitude,longitude\)/);
  assert.match(app, /dataset\.addressKey=key/);
  assert.match(app, /addEventListener\('click',geocodeMarketplaceAddress\)/);
});


test("ordinary Studio saves preserve server-owned published Store metadata", async () => {
  const storage = await read("../src/project-storage.ts");
  assert.match(storage, /const existingProjectObject = await env\.PROJECT_STORAGE\.get\(key\)/);
  assert.match(storage, /existingProject\?\.publishSlug/);
  assert.match(storage, /project\.publishSlug = existingPublishSlug/);
  assert.match(storage, /project\.publishedUrl = existingProject\.publishedUrl/);
  assert.match(storage, /project\.publishedAt = existingProject\.publishedAt/);
  assert.match(storage, /delete project\.publishSlug/);
  assert.match(storage, /Publication metadata is owned by this Worker/);
});


test("marketplace discovery repairs published Store projects missing their browser-overwritten slug", async () => {
  const marketplace = await read("../src/marketplace-directory.ts");
  assert.match(marketplace, /prefix: "published-sites\/index\/"/);
  assert.match(marketplace, /publishedByProject\.set\(mapping\.project_id/);
  assert.match(marketplace, /const publication = publishedByProject\.get\(project\.id\)/);
  assert.match(marketplace, /project\.publishSlug = slug/);
  assert.match(marketplace, /await env\.PROJECT_STORAGE\.put\(item\.key, JSON\.stringify\(project\)/);
});
