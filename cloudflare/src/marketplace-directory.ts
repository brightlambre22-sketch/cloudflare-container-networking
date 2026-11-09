import type { InventoryLedger } from "./inventory-ledger";
import { syncInventoryCatalog } from "./business-database";

export interface MarketplaceEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  INVENTORY_LEDGER: DurableObjectNamespace<InventoryLedger>;
  BUSINESS_DATABASE: DurableObjectNamespace;
  PROJECT_STORAGE: R2Bucket;
  STOCKROOM_ORIGIN?: string;
  STOCKROOM_GATEWAY_TOKEN?: string;
}

const ACCOUNT_ID = /^acct-[a-f0-9-]{36}$/;
const SITE_ID = /^[a-f0-9]{32}$/;
const PROJECT_ID = /^[a-z0-9-]{3,80}$/;
const PROFILE_PREFIX = "marketplace/merchants/";
const MARKET_RADIUS_MILES = 10;

// Nominatim is used for low-volume address verification. Successful lookups are
// cached in R2 so repeat edits do not repeatedly query the public geocoder.
let lastGeocodeRequestAt = 0;
async function geocodeStoreAddress(bucket: R2Bucket, address: string): Promise<{ latitude: number; longitude: number; display_name: string } | null> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address.toLowerCase().replace(/\s+/g, " ").trim()));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const cacheKey = "marketplace/geocode/" + hash + ".json";
  const cached = await readJson<{ latitude: number; longitude: number; display_name: string; cached_at: string }>(bucket, cacheKey);
  if (cached && Date.now() - Date.parse(cached.cached_at) < 30 * 24 * 60 * 60 * 1000 &&
      validCoordinates(cached.latitude, cached.longitude)) return cached;

  const waitMs = Math.max(0, 1100 - (Date.now() - lastGeocodeRequestAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastGeocodeRequestAt = Date.now();
  const endpoint = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(address);
  const response = await fetch(endpoint, {
    headers: { "accept": "application/json", "user-agent": "Vampirequid-Store-Locator/1.0" },
  });
  if (!response.ok) throw new Error("geocoder_http_" + response.status);
  const results = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const first = Array.isArray(results) ? results[0] : undefined;
  const latitude = first?.lat === undefined ? NaN : Number(first.lat);
  const longitude = first?.lon === undefined ? NaN : Number(first.lon);
  if (!first || !validCoordinates(latitude, longitude)) return null;
  const result = { latitude, longitude, display_name: String(first.display_name ?? address).slice(0, 500), cached_at: new Date().toISOString() };
  await bucket.put(cacheKey, JSON.stringify(result), { httpMetadata: { contentType: "application/json" } });
  return result;
}

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try { return await object.json<T>(); } catch { return null; }
}

async function authenticate(request: Request, env: MarketplaceEnv, accountId: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!ACCOUNT_ID.test(accountId) || !token) return false;
  const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const response = await registry.fetch("https://account-registry.internal/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: accountId, token }),
  });
  return response.ok;
}

function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function distanceMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLng = radians(bLng - aLng);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

type PublishedStore = { project_id: string; name: string; site_id: string; published_url: string };

async function getPublishedStores(env: MarketplaceEnv, accountId: string): Promise<PublishedStore[]> {
  const prefix = "accounts/" + accountId + "/projects/";
  const stores: PublishedStore[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PROJECT_STORAGE.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) {
      const project = await readJson<Record<string, unknown>>(env.PROJECT_STORAGE, item.key);
      // Older Studio releases saved the Store type with different casing.
      // Publication is confirmed independently by the signed-in owner's site index.
      const projectKind = typeof project?.kind === "string" ? project.kind.trim().toLowerCase() : "";
      if (!project || projectKind !== "store" || typeof project.id !== "string" ||
          !PROJECT_ID.test(project.id) || typeof project.publishSlug !== "string" || !SITE_ID.test(project.publishSlug)) continue;
      const mapping = await readJson<{ account_id?: string; project_id?: string }>(
        env.PROJECT_STORAGE, "published-sites/index/" + project.publishSlug + ".json",
      );
      if (mapping?.account_id !== accountId || mapping.project_id !== project.id) continue;
      stores.push({
        project_id: project.id,
        name: typeof project.name === "string" ? project.name.slice(0, 80) : "Local store",
        site_id: project.publishSlug,
        published_url: "/sites/" + project.publishSlug + "/",
      });
      if (stores.length >= 100) return stores;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return stores;
}

/**
 * Marketplace directory records only merchant discovery details. Product, price,
 * availability, and reservation data always come from each merchant's InventoryLedger.
 */
export async function handleMarketplaceRequest(request: Request, env: MarketplaceEnv): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/marketplace/profile") {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    if (request.method === "GET") {
      const [profile, stores] = await Promise.all([
        readJson<Record<string, unknown>>(env.PROJECT_STORAGE, PROFILE_PREFIX + accountId + ".json"),
        getPublishedStores(env, accountId),
      ]);
      return json({ ok: true, profile: profile ?? null, stores });
    }
    if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const latitude = body?.latitude;
    const longitude = body?.longitude;
    if (!body || typeof body.project_id !== "string" || !PROJECT_ID.test(body.project_id) ||
        typeof body.street_address !== "string" || body.street_address.trim().length < 4 || body.street_address.length > 180 ||
        typeof body.city !== "string" || body.city.trim().length < 2 || body.city.length > 80 ||
        typeof body.state !== "string" || !/^[A-Z]{2}$/.test(body.state.trim().toUpperCase()) ||
        typeof body.postal_code !== "string" || body.postal_code.length > 12 ||
        typeof latitude !== "number" || typeof longitude !== "number" || !validCoordinates(latitude, longitude)) {
      return json({ error: "invalid_marketplace_profile" }, 400);
    }
    const stores = await getPublishedStores(env, accountId);
    const selected = stores.find((store) => store.project_id === body.project_id);
    if (!selected) return json({ error: "published_store_not_found", note: "Publish a Store project before listing it in the marketplace." }, 409);
    const profile = {
      account_id: accountId,
      project_id: selected.project_id,
      site_id: selected.site_id,
      store_name: selected.name,
      street_address: body.street_address.trim(),
      city: body.city.trim().replace(/\s+/g, " "),
      state: body.state.trim().toUpperCase(),
      postal_code: body.postal_code.trim(),
      latitude: body.latitude,
      longitude: body.longitude,
      active: body.active !== false,
      updated_at: new Date().toISOString(),
    };
    await env.PROJECT_STORAGE.put(PROFILE_PREFIX + accountId + ".json", JSON.stringify(profile), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return json({ ok: true, profile: { ...profile, street_address: profile.street_address } });
  }

  if (url.pathname === "/api/marketplace/geocode") {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => null) as { street_address?: unknown; city?: unknown; state?: unknown; postal_code?: unknown; country?: unknown } | null;
    const parts = [body?.street_address, body?.city, body?.state, body?.postal_code, body?.country ?? "USA"];
    if (!body || parts.slice(0, 4).some((part) => typeof part !== "string") ||
        String(body.street_address).trim().length < 4 || String(body.street_address).length > 180 ||
        String(body.city).trim().length < 2 || String(body.city).length > 80 ||
        !/^[A-Z]{2}$/i.test(String(body.state).trim()) ||
        String(body.postal_code).trim().length < 3 || String(body.postal_code).length > 12) {
      return json({ error: "complete_store_address_required" }, 400);
    }
    const address = parts.map((part) => String(part ?? "").trim()).filter(Boolean).join(", ").slice(0, 400);
    try {
      const result = await geocodeStoreAddress(env.PROJECT_STORAGE, address);
      if (!result) return json({ error: "address_not_found", message: "No matching map location was found. Check the street, city, state, and ZIP code." }, 404);
      return json({ ok: true, latitude: result.latitude, longitude: result.longitude, display_name: result.display_name, provider: "OpenStreetMap Nominatim" });
    } catch (error) {
      return json({ error: "geocoding_unavailable", message: error instanceof Error ? error.message : "Address lookup failed." }, 502);
    }
  }

  // Resolve a shopper's ZIP code to a geographic point so marketplace search
  // can find stores within the configured radius instead of requiring an exact ZIP match.
  if (url.pathname === "/api/marketplace/location") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const postalCode = (url.searchParams.get("postal_code") ?? "").trim();
    if (!/^[0-9]{5}(?:-[0-9]{4})?$/.test(postalCode)) {
      return json({ error: "invalid_postal_code", message: "Enter a valid US ZIP code." }, 400);
    }
    try {
      const location = await geocodeStoreAddress(env.PROJECT_STORAGE, postalCode + ", USA");
      if (!location) return json({ error: "location_not_found", message: "We couldn't locate that ZIP code. Check it and try again." }, 404);
      return json({
        ok: true,
        postal_code: postalCode,
        latitude: location.latitude,
        longitude: location.longitude,
        display_name: location.display_name,
        provider: "OpenStreetMap Nominatim",
      });
    } catch (error) {
      return json({
        error: "location_lookup_unavailable",
        message: error instanceof Error ? error.message : "ZIP code lookup failed.",
      }, 502);
    }
  }

  if (url.pathname !== "/api/marketplace/products") return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const latitudeText = url.searchParams.get("lat");
  const longitudeText = url.searchParams.get("lng");
  let hasCoordinates = latitudeText !== null || longitudeText !== null;
  let latitude = latitudeText === null ? NaN : Number(latitudeText);
  let longitude = longitudeText === null ? NaN : Number(longitudeText);
  if (hasCoordinates && (!validCoordinates(latitude, longitude) || latitudeText?.trim() === "" || longitudeText?.trim() === "")) {
    return json({ error: "valid_location_required" }, 400);
  }
  let city = (url.searchParams.get("city") ?? "").trim().slice(0, 80).toLowerCase();
  const state = (url.searchParams.get("state") ?? "").trim().slice(0, 2).toUpperCase();
  let postal = (url.searchParams.get("postal_code") ?? "").trim().slice(0, 12);
  if (postal && !/^[0-9A-Za-z -]{3,12}$/.test(postal)) return json({ error: "invalid_postal_code" }, 400);
  // Older marketplace pages submit the location field as `city`, including
  // when the shopper enters a ZIP. Resolve ZIPs here so those pages work too;
  // if geocoding is unavailable, retain an exact ZIP match as a safe fallback.
  const cityZip = !hasCoordinates && !postal ? city.match(/^([0-9]{5})(?:-[0-9]{4})?$/) : null;
  if (cityZip) {
    postal = cityZip[1];
    city = "";
    try {
      const location = await geocodeStoreAddress(env.PROJECT_STORAGE, postal + ", USA");
      if (location) {
        latitude = location.latitude;
        longitude = location.longitude;
        hasCoordinates = true;
      }
    } catch {
      // The postal-code filter below still finds stores that serve this ZIP.
    }
  }
  if (!hasCoordinates && !city && !postal) return json({ error: "location_or_city_required" }, 400);

  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100).toLowerCase();
  const category = (url.searchParams.get("category") ?? "").trim().slice(0, 60).toLowerCase();
  const storeFilter = (url.searchParams.get("store") ?? "").trim().slice(0, 80).toLowerCase();
  const minPriceText = url.searchParams.get("min_price");
  const maxPriceText = url.searchParams.get("max_price");
  const minPrice = minPriceText === null ? 0 : Number(minPriceText);
  const maxPrice = maxPriceText === null ? 1000000 : Number(maxPriceText);
  if (!Number.isFinite(minPrice) || minPrice < 0 || !Number.isFinite(maxPrice) || maxPrice < minPrice || maxPrice > 1000000) {
    return json({ error: "invalid_price_range" }, 400);
  }
  const radiusText = url.searchParams.get("radius");
  const radius = radiusText === null ? MARKET_RADIUS_MILES : Number(radiusText);
  if (!Number.isFinite(radius) || radius < 1 || radius > 50) return json({ error: "invalid_radius" }, 400);
  const sort = url.searchParams.get("sort") ?? (hasCoordinates ? "distance" : "price_asc");
  if (!["distance", "price_asc", "price_desc", "name"].includes(sort)) return json({ error: "invalid_sort" }, 400);
  const pageSizeText = url.searchParams.get("limit");
  const pageSize = pageSizeText === null ? 60 : Number(pageSizeText);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return json({ error: "invalid_page_size" }, 400);
  const cursorText = url.searchParams.get("cursor") ?? "0";
  const offset = Number(cursorText);
  if (!/^\d{1,7}$/.test(cursorText) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
    return json({ error: "invalid_cursor" }, 400);
  }

  // Marketplace metadata is not an authority for account existence. Read the
  // shared auth registry once per search and fail closed if it cannot be checked.
  const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const activeResponse = await authRegistry.fetch("https://account-registry.internal/admin/list-accounts")
    .catch(() => new Response(null, { status: 503 }));
  if (!activeResponse.ok) return json({ error: "merchant_directory_unavailable" }, 503);
  const activeData = await activeResponse.json() as { accounts?: Array<{ account_id?: unknown }> };
  const activeAccounts = new Set((Array.isArray(activeData.accounts) ? activeData.accounts : [])
    .map((entry) => entry.account_id)
    .filter((id): id is string => typeof id === "string" && ACCOUNT_ID.test(id)));

  const matches: Array<Record<string, unknown>> = [];
  const categories = new Set<string>();
  let cursor: string | undefined;
  let storesChecked = 0;
  do {
    const page = await env.PROJECT_STORAGE.list({
      prefix: PROFILE_PREFIX, limit: 250, ...(cursor ? { cursor } : {}),
    });
    for (const item of page.objects) {
      if (storesChecked >= 500) break;
      storesChecked += 1;
      const profile = await readJson<Record<string, unknown>>(env.PROJECT_STORAGE, item.key);
      const storeLatitude = profile?.latitude;
      const storeLongitude = profile?.longitude;
      if (!profile || profile.active !== true || typeof profile.account_id !== "string" ||
          !ACCOUNT_ID.test(profile.account_id) || !activeAccounts.has(profile.account_id) || typeof profile.site_id !== "string" ||
          !SITE_ID.test(profile.site_id) || typeof storeLatitude !== "number" ||
          typeof storeLongitude !== "number" || !validCoordinates(storeLatitude, storeLongitude)) continue;
      const storeCity = String(profile.city ?? "");
      const storeState = String(profile.state ?? "").toUpperCase();
      const storePostal = String(profile.postal_code ?? "").trim().toLowerCase();
      const requestedPostal = postal.match(/^([0-9]{5})(?:-[0-9]{4})?$/)?.[1]?.toLowerCase() ?? postal.toLowerCase();
      const postalMatch = Boolean(postal && storePostal.startsWith(requestedPostal));
      if (city && !storeCity.toLowerCase().includes(city)) continue;
      if (state && storeState !== state) continue;
      // Exact ZIP matches remain valid even when a merchant's street geocode
      // is inaccurate. With coordinates, nearby stores in other ZIP codes are
      // still included by the normal radius check.
      if (postal && !hasCoordinates && !postalMatch) continue;
      const distance = hasCoordinates ? distanceMiles(latitude, longitude, storeLatitude, storeLongitude) : null;
      if (distance !== null && distance > radius && !postalMatch) continue;
      const mapping = await readJson<{ account_id?: string; project_id?: string }>(
        env.PROJECT_STORAGE, "published-sites/index/" + profile.site_id + ".json",
      );
      if (mapping?.account_id !== profile.account_id || mapping.project_id !== profile.project_id) continue;
      const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(profile.account_id));
      // Stockroom is the merchant's catalog authority. Refresh at most once
      // per minute so a missed product sync is repaired without making every
      // shopper search perform a full database read for every merchant.
      const syncKey = "marketplace/catalog-sync/" + profile.account_id + ".json";
      const syncState = await readJson<{ synced_at?: string }>(env.PROJECT_STORAGE, syncKey);
      const syncedAt = syncState?.synced_at ? Date.parse(syncState.synced_at) : 0;
      if (!Number.isFinite(syncedAt) || Date.now() - syncedAt > 60_000) {
        try {
          await syncInventoryCatalog(env, profile.account_id);
          await env.PROJECT_STORAGE.put(syncKey, JSON.stringify({ synced_at: new Date().toISOString() }), {
            httpMetadata: { contentType: "application/json" },
          });
        } catch {
          // Fall back to the last known online catalog if this merchant's Stockroom is offline.
        }
      }
      const catalogResponse = await ledger.fetch("https://inventory-ledger.internal/catalog");
      if (!catalogResponse.ok) continue;
      const catalog = await catalogResponse.json() as {
        products?: Array<{
          id: string; sku: string; name: string; description?: string; category?: string;
          image_url?: string; variations?: unknown[]; external_url?: string;
          price: number; quantity: number; in_stock: boolean;
        }>;
      };
      const storeName = String(profile.store_name ?? "Local store");
      for (const product of catalog.products ?? []) {
        if (!product.in_stock || Number(product.quantity) < 1) continue;
        const price = Number(product.price);
        if (!Number.isFinite(price) || price < minPrice || price > maxPrice) continue;
        const productCategory = String(product.category ?? "").trim();
        if (productCategory) categories.add(productCategory);
        if (category && productCategory.toLowerCase() !== category) continue;
        if (storeFilter && !storeName.toLowerCase().includes(storeFilter)) continue;
        const haystack = [product.name, product.description, product.sku, productCategory, storeName]
          .concat((product.variations ?? []).map((variation) => {
            if (!variation || typeof variation !== "object") return "";
            const value = variation as Record<string, unknown>;
            return [value.name, value.size, value.color, value.sku].filter(Boolean).join(" ");
          })).join(" ").toLowerCase();
        if (query && !haystack.includes(query)) continue;
        matches.push({
          id: product.id, product_id: product.id, site_id: profile.site_id,
          name: product.name, description: product.description ?? "",
          category: productCategory, sku: product.sku, image_url: product.image_url ?? "",
          price, quantity: product.quantity, in_stock: true, variations: product.variations ?? [],
          store: {
            name: storeName, address: String(profile.street_address ?? ""),
            city: storeCity, state: storeState, postal_code: String(profile.postal_code ?? ""),
            latitude: storeLatitude, longitude: storeLongitude,
          },
          distance_miles: distance === null || (postalMatch && distance > radius) ? null : Number(distance.toFixed(1)),
          postal_code_match: postalMatch,
        });
      }
    }
    if (storesChecked >= 500) break;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const stableTieBreak = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(a.site_id).localeCompare(String(b.site_id)) || String(a.product_id).localeCompare(String(b.product_id));
  matches.sort((a, b) => {
    if (sort === "price_asc") return Number(a.price) - Number(b.price) || stableTieBreak(a, b);
    if (sort === "price_desc") return Number(b.price) - Number(a.price) || stableTieBreak(a, b);
    if (sort === "name") return String(a.name).localeCompare(String(b.name)) || stableTieBreak(a, b);
    if (a.postal_code_match !== b.postal_code_match) return a.postal_code_match ? -1 : 1;
    return Number(a.distance_miles ?? Number.MAX_SAFE_INTEGER) - Number(b.distance_miles ?? Number.MAX_SAFE_INTEGER) || stableTieBreak(a, b);
  });
  const products = matches.slice(offset, offset + pageSize);
  const nextOffset = offset + products.length;
  return json({
    ok: true,
    location_mode: hasCoordinates ? "coordinates" : "city",
    city: city || null, state: state || null, postal_code: postal || null,
    radius_miles: hasCoordinates ? radius : null,
    sort, page_size: pageSize, offset,
    total_count: matches.length, result_count: products.length,
    next_cursor: nextOffset < matches.length ? String(nextOffset) : null,
    categories: Array.from(categories).sort((a, b) => a.localeCompare(b)),
    products,
  });
}
