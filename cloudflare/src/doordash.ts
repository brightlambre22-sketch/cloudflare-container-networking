export interface DoorDashEnv {
  PROJECT_STORAGE: R2Bucket;
  DOORDASH_ENVIRONMENT?: string;
  DOORDASH_DEVELOPER_ID?: string;
  DOORDASH_KEY_ID?: string;
  DOORDASH_SIGNING_SECRET?: string;
}

type CheckoutRecord = {
  id: string;
  account_id: string;
  site_id: string;
  amount_usd: string;
  status: string;
  delivery_status?: string;
  [key: string]: unknown;
};
type MerchantProfile = {
  store_name?: string;
  street_address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  active?: boolean;
};
type DeliveryRecord = {
  external_delivery_id: string;
  order_value_cents: number;
  quote: Record<string, unknown>;
  dropoff: { address: string; phone: string; name?: string; instructions?: string };
  created_at: string;
  status: "quoted" | "accepted" | "failed";
  delivery?: Record<string, unknown>;
};

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});
const accountOk = (id: unknown): id is string => typeof id === "string" && /^acct-[a-f0-9-]{36}$/.test(id);
const checkoutKey = (accountId: string, id: string) => `accounts/${accountId}/payments/checkout-${id}.json`;
const deliveryKey = (accountId: string, id: string) => `accounts/${accountId}/deliveries/${id}.json`;
const indexKey = (id: string) => `payment-index/${id}.json`;
const validCheckoutId = (id: string) => /^[a-f0-9-]{36}$/.test(id);

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try { return await object.json<T>(); } catch { return null; }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createDoorDashJwt(
  credentials: Pick<DoorDashEnv, "DOORDASH_DEVELOPER_ID" | "DOORDASH_KEY_ID" | "DOORDASH_SIGNING_SECRET">,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const developerId = credentials.DOORDASH_DEVELOPER_ID?.trim();
  const keyId = credentials.DOORDASH_KEY_ID?.trim();
  const signingSecret = credentials.DOORDASH_SIGNING_SECRET?.trim();
  if (!developerId || !keyId || !signingSecret) throw new Error("doordash_credentials_not_configured");
  const header = encodeJson({ alg: "HS256", typ: "JWT", "dd-ver": "DD-JWT-V1", kid: keyId });
  const payload = encodeJson({ aud: "doordash", iss: developerId, iat: nowSeconds, exp: nowSeconds + 300 });
  const unsigned = header + "." + payload;
  const key = await crypto.subtle.importKey(
    "raw", decodeBase64(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned)));
  return unsigned + "." + base64Url(signature);
}

async function doorDashRequest(
  env: DoorDashEnv, path: string, method: "GET" | "POST", body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const token = await createDoorDashJwt(env);
  const response = await fetch("https://openapi.doordash.com/drive/v2" + path, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, data };
}

async function loadCheckout(bucket: R2Bucket, id: string): Promise<CheckoutRecord | null> {
  const index = await readJson<{ account_id?: string }>(bucket, indexKey(id));
  if (!accountOk(index?.account_id)) return null;
  return readJson<CheckoutRecord>(bucket, checkoutKey(index.account_id, id));
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
}

/**
 * DoorDash Drive v2 adapter. All credentials and API traffic remain server-side.
 * The quote endpoint is public only for an unexpired, reserved checkout; delivery
 * acceptance is permitted only after PayPal/crypto capture has marked it paid.
 */
export async function handleDoorDashRequest(request: Request, env: DoorDashEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/delivery\/(quote|accept|status)\/([a-f0-9-]{36})$/);
  if (!match) return null;
  if (request.method !== (match[1] === "status" ? "GET" : "POST")) return json({ error: "method_not_allowed" }, 405);
  if (env.DOORDASH_ENVIRONMENT !== "sandbox" && env.DOORDASH_ENVIRONMENT !== "production") {
    return json({ error: "doordash_environment_not_configured" }, 503);
  }
  if (!env.DOORDASH_DEVELOPER_ID || !env.DOORDASH_KEY_ID || !env.DOORDASH_SIGNING_SECRET) {
    return json({ error: "doordash_credentials_not_configured" }, 503);
  }
  const action = match[1];
  const checkoutId = match[2];
  const checkout = await loadCheckout(env.PROJECT_STORAGE, checkoutId);
  if (!checkout || !accountOk(checkout.account_id)) return json({ error: "checkout_not_found" }, 404);
  const savedKey = deliveryKey(checkout.account_id, checkoutId);
  const saved = await readJson<DeliveryRecord>(env.PROJECT_STORAGE, savedKey);

  if (action === "quote") {
    if (saved?.status === "quoted") return json({ ok: true, reused: true, external_delivery_id: saved.external_delivery_id, fee: saved.quote.fee ?? null, currency: saved.quote.currency ?? "USD", estimated_pickup_time: saved.quote.pickup_time_estimated ?? null, estimated_dropoff_time: saved.quote.dropoff_time_estimated ?? null, expires_at: saved.quote.expires_at ?? null });
    const checkoutExpiresAt = Date.parse(String(checkout.expires_at ?? ""));
    if (checkout.status !== "pending" || !Number.isFinite(checkoutExpiresAt) || Date.now() > checkoutExpiresAt) {
      return json({ error: "checkout_not_available_for_delivery" }, 409);
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const dropoffAddress = cleanText(body?.dropoff_address, 300);
    const dropoffPhone = cleanText(body?.dropoff_phone_number, 24);
    const givenName = cleanText(body?.dropoff_contact_given_name, 60);
    const familyName = cleanText(body?.dropoff_contact_family_name, 60);
    const instructions = cleanText(body?.dropoff_instructions, 300);
    if (dropoffAddress.length < 8 || !/^\+[1-9]\d{7,14}$/.test(dropoffPhone)) {
      return json({ error: "valid_dropoff_address_and_e164_phone_required" }, 400);
    }
    const profile = await readJson<MerchantProfile>(
      env.PROJECT_STORAGE, "marketplace/merchants/" + checkout.account_id + ".json",
    );
    if (!profile || profile.active !== true) return json({ error: "merchant_delivery_profile_unavailable" }, 409);
    const pickupAddress = [
      cleanText(profile.street_address, 180), cleanText(profile.city, 80),
      cleanText(profile.state, 2), cleanText(profile.postal_code, 12),
    ].filter(Boolean).join(", ");
    if (pickupAddress.length < 10) return json({ error: "merchant_pickup_address_incomplete" }, 409);
    const externalId = "vq-" + checkoutId;
    const orderValue = Math.round(Number(checkout.amount_usd) * 100);
    if (!Number.isSafeInteger(orderValue) || orderValue < 1) return json({ error: "checkout_amount_invalid" }, 409);
    const result = await doorDashRequest(env, "/quotes", "POST", {
      external_delivery_id: externalId,
      order_fulfillment_method: "standard",
      locale: "en-US",
      pickup_address: pickupAddress,
      pickup_business_name: cleanText(profile.store_name, 80) || "Vampirequid merchant",
      pickup_reference_tag: checkoutId.slice(0, 20),
      dropoff_address: dropoffAddress,
      dropoff_phone_number: dropoffPhone,
      dropoff_contact_given_name: givenName || undefined,
      dropoff_contact_family_name: familyName || undefined,
      dropoff_instructions: /^[A-Za-z0-9_-]{3,64}$/.test(instructions) ? instructions : undefined,
      order_value: orderValue,
      contactless_dropoff: true,
    });
    if (!result.ok) return json({ error: "doordash_quote_failed", provider_status: result.status }, 502);
    const record: DeliveryRecord = {
      external_delivery_id: externalId, order_value_cents: orderValue, quote: result.data,
      dropoff: { address: dropoffAddress, phone: dropoffPhone, name: [givenName, familyName].filter(Boolean).join(" "), instructions },
      created_at: new Date().toISOString(), status: "quoted",
    };
    await env.PROJECT_STORAGE.put(savedKey, JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
    return json({
      ok: true, external_delivery_id: externalId,
      fee: result.data.fee ?? null, currency: result.data.currency ?? "USD",
      estimated_pickup_time: result.data.pickup_time_estimated ?? null,
      estimated_dropoff_time: result.data.dropoff_time_estimated ?? null,
      expires_at: result.data.expires_at ?? null,
    }, 201);
  }

  if (!saved) return json({ error: "delivery_quote_not_found" }, 404);
  if (action === "accept") {
    if (checkout.status !== "paid") return json({ error: "payment_required_before_delivery_acceptance" }, 409);
    if (checkout.delivery_fee_paid !== true) return json({ error: "delivery_fee_not_collected" }, 409);
    if (saved.status === "accepted" && saved.delivery) {
      return json({ ok: true, reused: true, delivery: publicDelivery(saved.delivery) });
    }
    // Resolve an ambiguous prior accept before retrying the same idempotency key.
    if (saved.status === "failed") {
      const recovered = await doorDashRequest(env, "/deliveries/" + encodeURIComponent(saved.external_delivery_id), "GET");
      if (recovered.ok) {
        const accepted: DeliveryRecord = { ...saved, status: "accepted", delivery: recovered.data };
        await env.PROJECT_STORAGE.put(savedKey, JSON.stringify(accepted), { httpMetadata: { contentType: "application/json" } });
        return json({ ok: true, reused: true, delivery: publicDelivery(recovered.data) });
      }
    }
    const result = await doorDashRequest(
      env, "/quotes/" + encodeURIComponent(saved.external_delivery_id) + "/accept", "POST",
      { order_value: saved.order_value_cents, dropoff_phone_number: saved.dropoff.phone },
    );
    if (!result.ok) {
      const failed = { ...saved, status: "failed" as const, provider_error_status: result.status };
      await env.PROJECT_STORAGE.put(savedKey, JSON.stringify(failed), { httpMetadata: { contentType: "application/json" } });
      return json({ error: "doordash_accept_failed", provider_status: result.status }, 502);
    }
    const accepted: DeliveryRecord = { ...saved, status: "accepted", delivery: result.data };
    await env.PROJECT_STORAGE.put(savedKey, JSON.stringify(accepted), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, delivery: publicDelivery(result.data) }, 201);
  }

  if (saved.status !== "accepted") return json({ error: "delivery_not_accepted" }, 409);
  const result = await doorDashRequest(env, "/deliveries/" + encodeURIComponent(saved.external_delivery_id), "GET");
  if (!result.ok) return json({ error: "doordash_status_failed", provider_status: result.status }, 502);
  const updated: DeliveryRecord = { ...saved, delivery: result.data };
  await env.PROJECT_STORAGE.put(savedKey, JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, delivery: publicDelivery(result.data) });
}

function publicDelivery(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "external_delivery_id", "delivery_status", "tracking_url", "fee", "currency",
    "pickup_time_estimated", "dropoff_time_estimated", "actual_pickup_time", "actual_dropoff_time",
  ];
  return Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
