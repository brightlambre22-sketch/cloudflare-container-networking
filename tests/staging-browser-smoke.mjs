import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = (process.env.STAGING_URL || "").replace(/\/$/, "");
assert.ok(base.startsWith("https://"), "STAGING_URL must be an HTTPS Worker Preview URL");

async function waitForPreview() {
  let lastError = "preview did not respond";
  for (let attempt = 0; attempt < 36; attempt += 1) {
    try {
      const response = await fetch(base + "/marketplace", { redirect: "manual", signal: AbortSignal.timeout(10000) });
      if (response.status === 200) return;
      lastError = "marketplace returned HTTP " + response.status;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Staging preview did not become ready: " + lastError);
}

await waitForPreview();

const marketplaceResponse = await fetch(base + "/marketplace");
assert.equal(marketplaceResponse.status, 200, "marketplace page should be public");
const marketplaceHtml = await marketplaceResponse.text();
assert.match(marketplaceHtml, /id="vq-map-plot"/, "marketplace must include its map container");
assert.match(marketplaceHtml, /leaflet@1\.9\.4\/dist\/leaflet\.js/, "marketplace must load Leaflet");

for (const path of ["/studio", "/studio.html", "/workspace", "/workspace.html", "/merchant-orders", "/merchant-orders.html", "/merchant-location", "/merchant-location.html"]) {
  const response = await fetch(base + path, { redirect: "manual" });
  assert.equal(response.status, 302, path + " must redirect without a session");
  assert.match(response.headers.get("location") || "", /\/vm\.html\?auth_required=1/, path + " must redirect to sign-in");
  const head = await fetch(base + path, { method: "HEAD", redirect: "manual" });
  assert.equal(head.status, 302, path + " HEAD must also be protected");
}

const locationResponse = await fetch(base + "/api/marketplace/location?postal_code=75038", { signal: AbortSignal.timeout(20000) });
assert.equal(locationResponse.status, 200, "ZIP lookup should succeed in staging");
const locationData = await locationResponse.json();
assert.equal(locationData.ok, true, "ZIP lookup should return ok");
assert.ok(Number.isFinite(locationData.latitude) && Number.isFinite(locationData.longitude), "ZIP lookup must return real coordinates");

const productsUrl = new URL(base + "/api/marketplace/products");
productsUrl.searchParams.set("postal_code", "75038");
productsUrl.searchParams.set("lat", String(locationData.latitude));
productsUrl.searchParams.set("lng", String(locationData.longitude));
productsUrl.searchParams.set("limit", "100");
const productsResponse = await fetch(productsUrl, { signal: AbortSignal.timeout(15000) });
assert.equal(productsResponse.status, 200, "ZIP product search should succeed");
const productsData = await productsResponse.json();
assert.equal(productsData.ok, true, "ZIP product search should return ok");
assert.ok(Array.isArray(productsData.products), "ZIP product search should return a products array");

// Exercise a real merchant signup -> provisioning -> login -> protected page ->
// logout -> re-login -> delete lifecycle. This uses only the isolated preview DOs
// and R2 bucket, then removes the synthetic account before the job exits.
const username = "stg" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const password = "Stage-" + crypto.randomUUID() + "-9!";
const signupResponse = await fetch(base + "/api/auth/signup", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(signupResponse.status, 202, "merchant signup should create a staging account");
const signup = await signupResponse.json();
const signupCookie = (signupResponse.headers.get("set-cookie") || "").split(";")[0];
let cleanupAccountId = signup.account_id;
try {
assert.match(String(signup.account_id || ""), /^acct-[a-f0-9-]{36}$/);
assert.match(String(signup.session_token || ""), /^[a-f0-9]{64}$/);
assert.match(signupResponse.headers.get("set-cookie") || "", /^vq_merchant_session=/);

let provision = null;
const provisionDeadline = Date.now() + 180000;
while (Date.now() < provisionDeadline) {
  const response = await fetch(base + "/api/auth/registration-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: signup.account_id, session_token: signup.session_token }),
  });
  provision = await response.json();
  if (response.ok && provision.complete === true) break;
  if (provision.status === "error") throw new Error("staging account provisioning failed: " + JSON.stringify(provision));
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
assert.equal(provision?.complete, true, "merchant snapshot provisioning should finish in staging");

const loginResponse = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(loginResponse.status, 200, "merchant login should succeed after provisioning");
const login = await loginResponse.json();
const loginCookie = (loginResponse.headers.get("set-cookie") || "").split(";")[0];
assert.match(loginCookie, /^vq_merchant_session=/);

// Create a complete synthetic merchant storefront in the isolated preview:
// project -> published site -> marketplace profile -> stockroom product.
const projectId = "stg-store-" + Date.now().toString(36);
const authHeaders = { "content-type": "application/json", authorization: "Bearer " + login.session_token };
const projectResponse = await fetch(base + "/api/studio/projects/" + projectId + "?account_id=" + encodeURIComponent(login.account_id), {
  method: "PUT",
  headers: authHeaders,
  body: JSON.stringify({ id: projectId, name: "Staging Sample Store", kind: "store" }),
});
assert.equal(projectResponse.status, 200, "merchant should be able to create a staging store project");

const publishResponse = await fetch(base + "/api/studio/publish?account_id=" + encodeURIComponent(login.account_id), {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ project_id: projectId, html: "<!doctype html><html><body><h1>Staging Sample Store</h1></body></html>" }),
});
assert.equal(publishResponse.status, 200, "merchant should be able to publish a staging storefront");
const published = await publishResponse.json();
const siteSlug = new URL(published.url).pathname.match(/^\/sites\/([a-f0-9]{32})\//)?.[1];
assert.ok(siteSlug, "published store should receive a public site ID");

const profileResponse = await fetch(base + "/api/marketplace/profile?account_id=" + encodeURIComponent(login.account_id), {
  method: "PUT",
  headers: authHeaders,
  body: JSON.stringify({
    project_id: projectId,
    street_address: "123 Main Street",
    city: "Irving",
    state: "TX",
    postal_code: "75038",
    latitude: locationData.latitude,
    longitude: locationData.longitude,
    active: true,
  }),
});
assert.equal(profileResponse.status, 200, "merchant should be able to list a published store in the marketplace");

const sku = "STG" + Date.now().toString(36).toUpperCase();
const productResponse = await fetch(base + "/api/stockroom/products?account_id=" + encodeURIComponent(login.account_id), {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ sku, name: "Staging Coffee Test " + username, description: "Synthetic staging-only catalog fixture", category: "Coffee", price: 12.5, cost: 4, quantity: 5, status: "active" }),
});
assert.equal(productResponse.status, 201, "merchant should be able to add a stockroom product");
const liveStoreSearchUrl = new URL(base + "/api/marketplace/products");
liveStoreSearchUrl.searchParams.set("postal_code", "75038");
liveStoreSearchUrl.searchParams.set("lat", String(locationData.latitude));
liveStoreSearchUrl.searchParams.set("lng", String(locationData.longitude));
liveStoreSearchUrl.searchParams.set("q", username);
const liveStoreSearch = await fetch(liveStoreSearchUrl);
assert.equal(liveStoreSearch.status, 200, "marketplace should find the new store by ZIP");
const liveStoreData = await liveStoreSearch.json();
assert.ok(liveStoreData.products.some((product) => product.store?.name === "Staging Sample Store"), "published merchant should appear in marketplace ZIP search");
assert.equal((await fetch(base + "/sites/" + siteSlug + "/")).status, 200, "published store should be publicly reachable before deletion");

for (const path of ["/studio.html", "/workspace.html", "/merchant-orders.html", "/merchant-location.html"]) {
  const response = await fetch(base + path, { headers: { cookie: loginCookie }, redirect: "manual" });
  assert.equal(response.status, 200, path + " should open with a valid merchant session");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const productQueries = [];
  const locationQueries = [];

  await page.route("**/api/marketplace/location?*", async (route) => {
    locationQueries.push(new URL(route.request().url()).searchParams.get("postal_code"));
    await route.continue();
  });
  await page.route("**/api/marketplace/products?*", async (route) => {
    productQueries.push(new URL(route.request().url()).searchParams.get("q") || "");
    await route.continue();
  });

  await page.goto(base + "/marketplace", { waitUntil: "domcontentloaded" });
  await page.locator("#vq-location").fill("75038");
  await page.locator("#q").fill(username);
  await page.locator("#location-search button[type=submit]").click();
  await page.waitForSelector("[data-products] .pcard", { timeout: 20000 });
  await page.waitForSelector("#vq-store-list .vq-store-list-item", { timeout: 10000 });
  await page.waitForSelector("#vq-map-plot .leaflet-marker-icon", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll("#vq-map-plot .leaflet-tile-loaded").length > 0, { timeout: 30000 });

  assert.match(await page.locator("#vq-store-list").innerText(), /Staging Sample Store/);
  assert.equal(await page.locator("#vq-map-plot .leaflet-marker-icon").count(), 1, "the store should appear as a real map marker");
  assert.ok(await page.locator("#vq-map-plot .leaflet-tile-loaded").count() > 0, "real map tiles should load");
  assert.match(await page.locator("[data-products]").innerText(), new RegExp("Staging Coffee Test " + username));

  await page.locator("#q").fill("tea");
  await page.locator("#q").press("Enter");
  await page.waitForFunction(() => document.querySelector("#vq-status")?.textContent?.includes("No live products found nearby"), null, { timeout: 15000 });
  assert.ok(productQueries.includes("tea"), "the top search bar should send the typed query");

  await page.locator("#q").fill(username);
  await page.locator("#q").press("Enter");
  await page.waitForFunction(() =>
    document.querySelector("[data-products]")?.textContent?.includes("Staging Coffee Test " + username) &&
    document.querySelectorAll("#vq-map-plot .leaflet-marker-icon").length > 0,
    null,
    { timeout: 15000 },
  );
  assert.ok(productQueries.filter((query) => query === username).length >= 2, "searching coffee again should reload the real store");
  assert.ok(locationQueries.includes("75038"), "ZIP search should call the real location endpoint");

  assert.deepEqual(pageErrors, [], "marketplace should not throw browser JavaScript errors");
  console.log(JSON.stringify({
    preview: base,
    protected_pages: "passed",
    zip_geocoding: "passed",
    backend_zip_search: "passed",
    search_bar: "passed",
    real_leaflet_map_tiles: await page.locator("#vq-map-plot .leaflet-tile-loaded").count(),
    store_markers: await page.locator("#vq-map-plot .leaflet-marker-icon").count(),
  }, null, 2));
} finally {
  await browser.close();
}

const logoutResponse = await fetch(base + "/api/auth/logout", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: loginCookie },
  body: JSON.stringify({ account_id: login.account_id, session_token: login.session_token }),
});
assert.equal(logoutResponse.status, 200, "merchant logout should succeed");
const afterLogout = await fetch(base + "/studio.html", { redirect: "manual" });
assert.equal(afterLogout.status, 302, "merchant pages must close immediately after logout");

const reloginResponse = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(reloginResponse.status, 200, "merchant can log in again after logout");
const relogin = await reloginResponse.json();
const reloginCookie = (reloginResponse.headers.get("set-cookie") || "").split(";")[0];
const deletionResponse = await fetch(base + "/api/account/delete", {
  method: "DELETE",
  headers: { "content-type": "application/json", cookie: reloginCookie },
  body: JSON.stringify({ account_id: relogin.account_id, session_token: relogin.session_token }),
});
assert.equal(deletionResponse.status, 200, "merchant self-delete should complete all account cleanup");
const afterDeleteSearch = await fetch(liveStoreSearchUrl);
assert.equal(afterDeleteSearch.status, 200, "marketplace search should remain available after deletion");
const afterDeleteData = await afterDeleteSearch.json();
assert.equal(afterDeleteData.products.length, 0, "deleted merchant products must disappear from marketplace ZIP search");
assert.equal((await fetch(base + "/sites/" + siteSlug + "/")).status, 404, "deleted merchant's published store must no longer resolve");

const emptyBrowser = await chromium.launch({ headless: true });
try {
  const emptyPage = await emptyBrowser.newPage();
  await emptyPage.goto(base + "/marketplace", { waitUntil: "domcontentloaded" });
  await emptyPage.locator("#vq-location").fill("75038");
  await emptyPage.locator("#q").fill("coffee");
  await emptyPage.locator("#location-search button[type=submit]").click();
  await emptyPage.waitForFunction(() => document.querySelector("#vq-status")?.textContent?.includes("No live products found nearby"), null, { timeout: 15000 });
  assert.equal(await emptyPage.locator("#vq-map-plot .leaflet-marker-icon").count(), 0, "deleted store must not leave a map marker");
  assert.equal(await emptyPage.locator("#vq-store-list .vq-store-list-item").count(), 0, "deleted store must not remain in the map's store list");
} finally {
  await emptyBrowser.close();
}

const deletedLogin = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(deletedLogin.status, 401, "deleted merchant credentials must no longer authenticate");
const adminSessionResponse = await fetch(base + "/api/admin/session");
assert.equal(adminSessionResponse.status, 401, "admin APIs must reject visitors without an admin session");
cleanupAccountId = null;
} finally {
  if (cleanupAccountId) {
    try {
      await fetch(base + "/api/account/delete", {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie: signupCookie },
        body: JSON.stringify({ account_id: cleanupAccountId, session_token: signup.session_token }),
      });
    } catch (error) {
      console.error("staging cleanup failed:", error);
    }
  }
}


