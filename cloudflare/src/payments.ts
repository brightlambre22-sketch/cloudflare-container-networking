import type { InventoryLedger } from "./inventory-ledger";
import { handleDoorDashRequest } from "./doordash.ts";
import { synchronizePendingOrders } from "./business-database";
export interface PaymentEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  PROJECT_STORAGE: R2Bucket;
  INVENTORY_LEDGER: DurableObjectNamespace<InventoryLedger>;
  BUSINESS_DATABASE: DurableObjectNamespace;
  STOCKROOM_ORIGIN?: string;
  STOCKROOM_GATEWAY_TOKEN?: string;
  PAYMENTS_ENCRYPTION_KEY?: string;
  DOORDASH_ENVIRONMENT?: string;
  DOORDASH_DEVELOPER_ID?: string;
  DOORDASH_KEY_ID?: string;
  DOORDASH_SIGNING_SECRET?: string;
}
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const accountOk = (id: string) => /^acct-[a-f0-9-]{36}$/.test(id);
const addressOk = (value: unknown): value is string => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
const keyFor = (account: string, suffix: string) => `accounts/${account}/payments/${suffix}.json`;

async function authenticate(request: Request, env: PaymentEnv, accountId: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!accountOk(accountId) || !token) return false;
  const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const response = await registry.fetch("https://account-registry.internal/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId, token }),
  });
  return response.ok;
}
async function commitInventory(env: PaymentEnv, checkout: { id: string; account_id: string }, paymentReference: string, paymentMethod: string): Promise<{ ok: boolean; order_id?: string }> {
  try {
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(checkout.account_id));
    const response = await ledger.fetch("https://inventory-ledger.internal/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkout_id: checkout.id, payment_reference: paymentReference, payment_method: paymentMethod }),
    });
    const result = await response.json() as { order_id?: string };
    if (response.ok) {
      // The ledger commit is authoritative. Push the order into the merchant's
      // Stockroom immediately when available; if TinyCore is offline, the durable
      // ledger queue remains intact and the merchant order API still exposes it.
      await synchronizePendingOrders(env, checkout.account_id).catch(() => undefined);
    }
    return { ok: response.ok, order_id: result.order_id };
  } catch {
    return { ok: false };
  }
}
async function acceptQuotedDelivery(env: PaymentEnv, checkoutId: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await handleDoorDashRequest(new Request("https://worker.internal/api/delivery/accept/" + checkoutId, { method: "POST" }), env);
    if (!response?.ok) return null;
    const result = await response.json() as { delivery?: Record<string, unknown> };
    return result.delivery ?? null;
  } catch { return null; }
}
async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key); if (!obj) return null;
  try { return await obj.json<T>(); } catch { return null; }
}
function validPayPalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try { const u = new URL(value); return u.protocol === "https:" && (u.hostname === "paypal.me" || u.hostname.endsWith(".paypal.com") || u.hostname === "www.paypal.com"); } catch { return false; }
}
export async function handlePayments(request: Request, env: PaymentEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const publicStoreMatch = url.pathname.match(/^\/api\/payments\/public\/checkout\/([a-f0-9]{32})$/);
  if (publicStoreMatch) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const siteId = publicStoreMatch[1];
    const mapping = await readJson<{ account_id?: string; project_id?: string }>(env.PROJECT_STORAGE, "published-sites/index/" + siteId + ".json");
    if (!mapping?.account_id || !accountOk(mapping.account_id)) return json({ error: "site_not_found" }, 404);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(mapping.account_id, "settings"));
    const credentials = await getPaypalCredentials(env, mapping.account_id);
    if (!settings || (!settings.crypto_enabled && !(settings.paypal_enabled && credentials))) return json({ error: "merchant_payment_method_not_configured" }, 409);
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(mapping.account_id));
    let catalogResponse = await ledger.fetch("https://inventory-ledger.internal/catalog");
    let catalogData = await catalogResponse.json() as { products?: Array<{ id: string; name: string; price: number; quantity: number }> };
    let catalog = new Map<string, { name: string; price: number; quantity: number }>();
    const loadCatalog = () => {
      catalog = new Map();
      for (const product of catalogData.products ?? []) {
        if (typeof product.id === "string" && Number.isFinite(product.price) && product.price > 0) {
          catalog.set(product.id, { name: product.name, price: product.price, quantity: Number(product.quantity) || 0 });
        }
      }
    };
    loadCatalog();
    // Checkout reads only the always-online Cloudflare inventory ledger. TinyCore is never contacted here.
    if (!catalogResponse.ok) return json({ error: "inventory_service_unavailable" }, 503);
    if (!catalog.size) return json({ error: "store_catalog_empty" }, 409);
    const body = await request.json().catch(() => null) as { items?: unknown } | null;
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 20) return json({ error: "invalid_cart" }, 400);
    const quantities = new Map<string, number>();
    for (const item of body.items) {
      if (!item || typeof item !== "object") return json({ error: "invalid_cart_item" }, 400);
      const productId = (item as { product_id?: unknown }).product_id;
      const quantity = (item as { quantity?: unknown }).quantity;
      if (typeof productId !== "string" || !catalog.has(productId) || !Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 99) return json({ error: "invalid_cart_item" }, 400);
      const requested = (quantities.get(productId) ?? 0) + Number(quantity);
      if (requested > catalog.get(productId)!.quantity) return json({ error: "insufficient_stock", product_id: productId }, 409);
      quantities.set(productId, requested);
    }
    let amount = 0;
    const lineItems = Array.from(quantities, ([product_id, quantity]) => {
      const product = catalog.get(product_id)!;
      amount += product.price * quantity;
      return { product_id, name: product.name, quantity, unit_amount_usd: product.price.toFixed(2) };
    });
    amount = Math.round(amount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999) return json({ error: "cart_total_invalid" }, 400);
    const id = crypto.randomUUID();
    const reservedResponse = await ledger.fetch("https://inventory-ledger.internal/reserve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkout_id: id, items: Array.from(quantities, ([product_id, quantity]) => ({ product_id, quantity })), ttl_seconds: 1800 }),
    });
    const reserved = await reservedResponse.json() as { amount_cents?: number; expires_at?: string; items?: Array<{product_id:string;name:string;quantity:number;unit_amount_usd:string}> };
    if (!reservedResponse.ok || !Array.isArray(reserved.items) || !Number.isSafeInteger(reserved.amount_cents)) return json({ error: "inventory_reservation_failed", detail: (reserved as any).error ?? "reservation_unavailable" }, 409);
    amount = Number(reserved.amount_cents) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999) {
      await ledger.fetch("https://inventory-ledger.internal/release", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({checkout_id:id})});
      return json({error:"cart_total_invalid"},400);
    }
    const reservedLineItems = reserved.items.map(x => ({ product_id:x.product_id,name:x.name,quantity:x.quantity,unit_amount_usd:x.unit_amount_usd }));
    const record = { id, account_id: mapping.account_id, site_id: siteId, paypal_mode: credentials?.mode ?? null, amount_usd: amount.toFixed(2), description: reservedLineItems.map(x => x.quantity + " × " + x.name).join(", ").slice(0, 120), items: reservedLineItems, status: "pending", created_at: new Date().toISOString(), expires_at: reserved.expires_at ?? new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    try {
      await env.PROJECT_STORAGE.put(keyFor(mapping.account_id, "checkout-" + id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
      await env.PROJECT_STORAGE.put("payment-index/" + id + ".json", JSON.stringify({ account_id: mapping.account_id }), { httpMetadata: { contentType: "application/json" } });
    } catch (error) {
      await ledger.fetch("https://inventory-ledger.internal/release", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({checkout_id:id})});
      throw error;
    }
    return json({ ok: true, checkout: record, url: new URL("/checkout.html?id=" + id, url.origin).toString() }, 201);
  }
  if (!url.pathname.startsWith("/api/payments/")) return null;
  const settingsMatch = url.pathname === "/api/payments/settings";
  const createMatch = url.pathname === "/api/payments/checkout";
  const paypalConnectMatch = url.pathname === "/api/payments/paypal/connect";
  const paypalStatusMatch = url.pathname === "/api/payments/paypal/status";
  const paypalTestMatch = url.pathname === "/api/payments/paypal/test";
  const paypalCreateMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/paypal\/create-order$/);
  const paypalCaptureMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/paypal\/capture$/);
  const publicMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})$/);
  const verifyMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/verify$/);
  const webhookMatch = url.pathname.match(/^\/api\/payments\/paypal\/webhook\/(acct-[a-f0-9-]{36})\/(sandbox|live)$/);
  const historyMatch = url.pathname === "/api/payments/history";
  if (!settingsMatch && !createMatch && !publicMatch && !verifyMatch && !paypalConnectMatch && !paypalStatusMatch && !paypalTestMatch && !paypalCreateMatch && !paypalCaptureMatch && !webhookMatch && !historyMatch) return json({ error: "not_found" }, 404);
  if (webhookMatch && request.method === "POST") {
    const [, accountId, mode] = webhookMatch;
    const saved = await readJson<any>(env.PROJECT_STORAGE, keyFor(accountId, "paypal-credentials-" + mode));
    if (!saved?.webhook_id || !saved?.iv || !saved?.ciphertext) return json({ error: "paypal_webhook_not_configured" }, 503);
    const credentials = await decryptCredentials(env.PAYMENTS_ENCRYPTION_KEY ?? "", saved);
    const host = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    const access = await paypalAccessToken(host, credentials);
    const rawBody = await request.text();
    let event: any;
    try { event = JSON.parse(rawBody); } catch { return json({ error: "invalid_webhook_json" }, 400); }
    const header = (name: string) => request.headers.get(name) ?? "";
    const verification = await fetch(host + "/v1/notifications/verify-webhook-signature", {
      method: "POST", headers: { authorization: "Bearer " + access, "content-type": "application/json" },
      body: JSON.stringify({ auth_algo: header("paypal-auth-algo"), cert_url: header("paypal-cert-url"),
        transmission_id: header("paypal-transmission-id"), transmission_sig: header("paypal-transmission-sig"),
        transmission_time: header("paypal-transmission-time"), webhook_id: saved.webhook_id, webhook_event: event }),
    });
    const verified = await verification.json() as { verification_status?: string };
    if (!verification.ok || verified.verification_status !== "SUCCESS") return json({ error: "paypal_webhook_signature_invalid" }, 400);
    const eventId = typeof event.id === "string" ? event.id : "";
    const eventType = typeof event.event_type === "string" ? event.event_type : "";
    if (!eventId || !eventType) return json({ error: "invalid_paypal_event" }, 400);
    const eventKey = keyFor(accountId, "events/paypal-webhook-" + eventId);
    if (await env.PROJECT_STORAGE.head(eventKey)) return json({ ok: true, duplicate: true });
    const resource = event.resource ?? {};
    const relatedIds = resource.supplementary_data?.related_ids ?? {};
    const relatedOrderId = relatedIds.order_id ?? (eventType === "CHECKOUT.PAYMENT-APPROVAL.REVERSED" ? resource.id ?? null : null);
    const captureId = relatedIds.capture_id ?? (eventType.startsWith("PAYMENT.CAPTURE.") && eventType !== "PAYMENT.CAPTURE.REFUNDED" ? resource.id : null);
    const prefix = `accounts/${accountId}/payments/checkout-`;
    let cursor: string | undefined, checkout: any = null;
    do {
      const page = await env.PROJECT_STORAGE.list({ prefix, limit: 1000, cursor });
      for (const object of page.objects) {
        const candidate = await readJson<any>(env.PROJECT_STORAGE, object.key);
        if (candidate && ((relatedOrderId && candidate.paypal_order_id === relatedOrderId) ||
          (captureId && candidate.paypal_capture_id === captureId))) { checkout = candidate; break; }
      }
      if (checkout) break;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (!checkout) return json({ error: "paypal_webhook_checkout_not_found" }, 404);
    const occurredAt = event.create_time ?? new Date().toISOString();
    const next = { ...checkout };
    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      next.status = "paid"; next.paid_at = next.paid_at ?? occurredAt;
      next.paypal_capture_id = captureId ?? next.paypal_capture_id;
      next.payment_method = "paypal";
      // A webhook may be the first confirmation when the browser capture
      // response is interrupted. Commit inventory idempotently in that case.
      const committed = await commitInventory(env, checkout, relatedOrderId ?? captureId ?? eventId, "paypal");
      next.inventory_status = committed.ok ? "queued_for_tinycore_sync" : "needs_review";
      next.order_id = committed.order_id ?? next.order_id;
    }
    else if (eventType === "PAYMENT.CAPTURE.PENDING") next.payment_status = "pending";
    else if (eventType === "PAYMENT.CAPTURE.DENIED") next.paypal_last_capture_failure = { issue: "PAYMENT.CAPTURE.DENIED", occurred_at: occurredAt };
    else if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
      const refundAmount = Number(resource.amount?.value ?? 0);
      const priorRefunded = Number(checkout.refunded_amount_usd ?? 0);
      next.refunded_amount_usd = (priorRefunded + refundAmount).toFixed(2);
      next.status = Number(next.refunded_amount_usd) >= Number(checkout.amount_usd) ? "refunded" : "partially_refunded";
    } else if (eventType === "PAYMENT.CAPTURE.REVERSED" || eventType === "CHECKOUT.PAYMENT-APPROVAL.REVERSED") next.status = "reversed";
    else if (eventType === "PAYMENT.CAPTURE.VOIDED") next.status = "voided";
    else return json({ ok: true, ignored: true, event_type: eventType });
    await env.PROJECT_STORAGE.put(keyFor(accountId, "checkout-" + checkout.id), JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
    await env.PROJECT_STORAGE.put(eventKey, JSON.stringify({ account_id: accountId, checkout_id: checkout.id,
      type: eventType.toLowerCase(), status: next.status ?? next.payment_status ?? "updated", paypal_event_id: eventId,
      paypal_order_id: relatedOrderId, paypal_capture_id: captureId, amount: resource.amount ?? null, occurred_at: occurredAt }),
      { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, processed: true, status: next.status ?? next.payment_status });
  }
  if (paypalConnectMatch || paypalStatusMatch || paypalTestMatch) {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    if (paypalTestMatch && !env.PAYMENTS_ENCRYPTION_KEY) return json({ error: "payments_encryption_key_not_configured" }, 503);
    const key = keyFor(accountId, "paypal-credentials");
    const selectedMode = url.searchParams.get("mode") === "live" ? "live" : "sandbox";
    const modeKey = (mode: "sandbox" | "live") => keyFor(accountId, "paypal-credentials-" + mode);
    if (paypalStatusMatch && request.method === "GET") {
      const saved = await readJson<{ mode: string; client_id: string; iv?: string; ciphertext?: string }>(env.PROJECT_STORAGE, modeKey(selectedMode))
        ?? await readJson<{ mode: string; client_id: string; iv?: string; ciphertext?: string }>(env.PROJECT_STORAGE, key).then(x => x?.mode === selectedMode ? x : null);
      const sandbox = await readJson<{ client_id?: string; iv?: string; ciphertext?: string }>(env.PROJECT_STORAGE, modeKey("sandbox"));
      const live = await readJson<{ client_id?: string; iv?: string; ciphertext?: string }>(env.PROJECT_STORAGE, modeKey("live"));
      return json({
        ok: true, connected: Boolean(saved?.iv && saved?.ciphertext && saved.client_id), mode: selectedMode,
        client_id: saved?.iv && saved?.ciphertext ? saved.client_id : null, webhook_status: saved?.webhook_status ?? "not_registered",
        available_modes: {
          sandbox: Boolean(sandbox?.iv && sandbox?.ciphertext && sandbox.client_id),
          live: Boolean(live?.iv && live?.ciphertext && live.client_id),
        },
      });
    }
    if (paypalTestMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { mode?: unknown } | null;
      if (body?.mode !== "sandbox" && body?.mode !== "live") return json({ error: "invalid_paypal_mode" }, 400);
      const saved = await readJson<{ iv?: string; ciphertext?: string }>(env.PROJECT_STORAGE, modeKey(body.mode));
      if (!saved?.iv || !saved.ciphertext) return json({ error: "paypal_mode_not_connected", mode: body.mode }, 409);
      try {
        const credentials = await decryptCredentials(env.PAYMENTS_ENCRYPTION_KEY ?? "", saved as { iv: string; ciphertext: string });
        if (credentials.mode !== body.mode) return json({ error: "paypal_mode_mismatch" }, 409);
        const host = credentials.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
        await paypalAccessToken(host, credentials);
        return json({ ok: true, verified: true, mode: credentials.mode, message: "PayPal OAuth authentication succeeded. No payment was taken." });
      } catch {
        return json({ error: "paypal_connection_test_failed" }, 502);
      }
    }
    if (paypalConnectMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { mode?: unknown } | null;
      if (body?.mode !== "sandbox" && body?.mode !== "live") return json({ error: "invalid_paypal_mode" }, 400);
      const saved = await readJson<any>(env.PROJECT_STORAGE, modeKey(body.mode));
      if (!saved?.iv || !saved?.ciphertext) return json({ error: "paypal_mode_not_connected", mode: body.mode }, 409);
      await env.PROJECT_STORAGE.put(key, JSON.stringify(saved), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, connected: true, mode: body.mode, client_id: saved.client_id });
    }
    if (paypalConnectMatch && request.method === "DELETE") {
      await Promise.all([env.PROJECT_STORAGE.delete(key), env.PROJECT_STORAGE.delete(modeKey("sandbox")), env.PROJECT_STORAGE.delete(modeKey("live"))]);
      const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(accountId, "settings")) ?? {};
      settings.paypal_enabled = false;
      await env.PROJECT_STORAGE.put(keyFor(accountId, "settings"), JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, connected: false });
    }
    if (paypalConnectMatch && request.method === "PUT") {
      if (!env.PAYMENTS_ENCRYPTION_KEY) return json({ error: "payments_encryption_key_not_configured" }, 503);
      const body = await request.json().catch(() => null) as { client_id?: unknown; client_secret?: unknown; mode?: unknown } | null;
      if (typeof body?.client_id !== "string" || body.client_id.length < 8 || body.client_id.length > 200 || typeof body.client_secret !== "string" || body.client_secret.length < 8 || body.client_secret.length > 300 || !["sandbox", "live"].includes(String(body.mode))) return json({ error: "invalid_paypal_credentials" }, 400);
      const credentials = { client_id: body.client_id.trim(), client_secret: body.client_secret.trim(), mode: body.mode as "sandbox" | "live" };
      const host = credentials.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(host + "/v1/oauth2/token", { method: "POST", headers: { authorization: "Basic " + btoa(credentials.client_id + ":" + credentials.client_secret), "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
      } catch {
        return json({ error: "paypal_validation_unavailable" }, 502);
      }
      if (!tokenResponse.ok) return json({ error: "paypal_credentials_rejected", paypal_status: tokenResponse.status }, 400);
      let encrypted: { iv: string; ciphertext: string };
      try { encrypted = await encryptCredentials(env.PAYMENTS_ENCRYPTION_KEY, credentials); }
      catch { return json({ error: "payments_encryption_key_invalid" }, 503); }
      const savedCredential: { iv: string; ciphertext: string; mode: string; client_id: string; connected_at: string; webhook_id?: string; webhook_status?: string } = { ...encrypted, mode: credentials.mode, client_id: credentials.client_id, connected_at: new Date().toISOString() };
      const webhookUrl = new URL("/api/payments/paypal/webhook/" + accountId + "/" + credentials.mode, url.origin).toString();
      let reusedWebhook = false;
      const existingCredential = await readJson<any>(env.PROJECT_STORAGE, modeKey(credentials.mode));
      if (existingCredential?.webhook_id && existingCredential.iv && existingCredential.ciphertext) {
        try {
          const existingPlain = await decryptCredentials(env.PAYMENTS_ENCRYPTION_KEY, existingCredential);
          if (existingPlain.client_id === credentials.client_id && existingPlain.client_secret === credentials.client_secret &&
              existingPlain.mode === credentials.mode && existingCredential.webhook_url === webhookUrl &&
              existingCredential.webhook_status === "active") {
            savedCredential.webhook_id = existingCredential.webhook_id;
            savedCredential.webhook_url = webhookUrl;
            savedCredential.webhook_status = "active";
            reusedWebhook = true;
          }
        } catch { /* Replace unreadable or mismatched credentials and register a fresh webhook. */ }
      }
      if (!reusedWebhook) {
        try {
          const access = await paypalAccessToken(host, credentials);
          // Reuse an already-registered subscription for this exact callback URL,
          // including subscriptions created manually before Vampirequid managed them.
          const requiredEvents = ["PAYMENT.CAPTURE.COMPLETED","PAYMENT.CAPTURE.PENDING","PAYMENT.CAPTURE.DENIED","PAYMENT.CAPTURE.REFUNDED","PAYMENT.CAPTURE.REVERSED","PAYMENT.CAPTURE.VOIDED","CHECKOUT.PAYMENT-APPROVAL.REVERSED"];
          const listResponse = await fetch(host + "/v1/notifications/webhooks", {
            headers: { authorization: "Bearer " + access },
          });
          if (listResponse.ok) {
            const list = await listResponse.json() as { webhooks?: Array<{ id?: string; url?: string; event_types?: Array<{ name?: string }> }> };
            const existing = list.webhooks?.find(item => item.url === webhookUrl && item.id &&
              requiredEvents.every(name => item.event_types?.some(event => event.name === name)));
            if (existing?.id) {
              savedCredential.webhook_id = existing.id;
              savedCredential.webhook_url = webhookUrl;
              savedCredential.webhook_status = "active";
              reusedWebhook = true;
            }
          }
          if (!reusedWebhook) {
            const webhookResponse = await fetch(host + "/v1/notifications/webhooks", {
              method: "POST", headers: { authorization: "Bearer " + access, "content-type": "application/json" },
              body: JSON.stringify({ url: webhookUrl, event_types: requiredEvents.map(name => ({ name })) }),
            });
            const webhook = await webhookResponse.json() as { id?: string };
            savedCredential.webhook_url = webhookUrl;
            if (webhookResponse.ok && webhook.id) { savedCredential.webhook_id = webhook.id; savedCredential.webhook_status = "active"; }
            else savedCredential.webhook_status = "registration_failed";
          }
        } catch { savedCredential.webhook_url = webhookUrl; savedCredential.webhook_status = "registration_failed"; }
      }
      await env.PROJECT_STORAGE.put(modeKey(credentials.mode), JSON.stringify(savedCredential), { httpMetadata: { contentType: "application/json" } });
      await env.PROJECT_STORAGE.put(key, JSON.stringify(savedCredential), { httpMetadata: { contentType: "application/json" } });
      const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(accountId, "settings")) ?? { wallet_address: "", crypto_enabled: false };
      settings.paypal_enabled = true;
      await env.PROJECT_STORAGE.put(keyFor(accountId, "settings"), JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, connected: true, mode: credentials.mode, client_id: credentials.client_id, webhook_status: savedCredential.webhook_status ?? "not_registered" });
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (paypalCreateMatch || paypalCaptureMatch) {
    const id = (paypalCreateMatch ?? paypalCaptureMatch)![1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    if (page.status === "paid") {
      if (page.inventory_status === "needs_review" && page.paypal_order_id) {
        const repaired = await commitInventory(env, page, page.paypal_order_id, "paypal");
        const updated = { ...page, inventory_status: repaired.ok ? "queued_for_tinycore_sync" : "needs_review", order_id: repaired.order_id ?? page.order_id };
        await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
        const delivery = await acceptQuotedDelivery(env, id);
        return json({ ok: true, status: "paid", inventory_status: updated.inventory_status, order_id: updated.order_id ?? null, delivery });
      }
      const delivery = await acceptQuotedDelivery(env, id);
      return json({ ok: true, status: "paid", inventory_status: page.inventory_status ?? "complete", delivery });
    }
    if (Date.now() > Date.parse(page.expires_at)) return json({ error: "checkout_expired" }, 410);
    const paymentSettings = await readJson<any>(env.PROJECT_STORAGE, keyFor(page.account_id, "settings"));
    if (!paymentSettings?.paypal_enabled) return json({ error: "paypal_not_enabled" }, 409);
    const credentials = await getPaypalCredentials(env, page.account_id, page.paypal_mode === "live" ? "live" : page.paypal_mode === "sandbox" ? "sandbox" : undefined);
    if (!credentials) return json({ error: "paypal_not_connected" }, 409);
    const host = credentials.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    let access: string;
    try { access = await paypalAccessToken(host, credentials); }
    catch { return json({ error: "paypal_authentication_unavailable" }, 502); }
    if (paypalCreateMatch && request.method === "POST") {
      const orderKey = keyFor(page.account_id, "paypal-order-" + id);
      const existing = await readJson<{ order_id?: string }>(env.PROJECT_STORAGE, orderKey);
      if (existing?.order_id) return json({ ok: true, order_id: existing.order_id, reused: true });
      const created = await fetch(host + "/v2/checkout/orders", {
        method: "POST",
        headers: { authorization: "Bearer " + access, "content-type": "application/json", prefer: "return=representation", "PayPal-Request-Id": id },
        body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: id, custom_id: id, description: String(page.description).slice(0, 127), amount: { currency_code: "USD", value: Number(page.amount_usd).toFixed(2) } }] }),
      });
      const order = await created.json() as { id?: string };
      if (!created.ok || !order.id) return json({ error: "paypal_order_creation_failed", paypal_status: created.status }, 502);
      await env.PROJECT_STORAGE.put(orderKey, JSON.stringify({ order_id: order.id, mode: credentials.mode, created_at: new Date().toISOString() }), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, order_id: order.id });
    }
    if (paypalCaptureMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { order_id?: unknown } | null;
      const orderKey = keyFor(page.account_id, "paypal-order-" + id);
      const saved = await readJson<{ order_id: string; capture_request_id?: string | null; mode?: string }>(env.PROJECT_STORAGE, orderKey);
      if (!saved || body?.order_id !== saved.order_id) return json({ error: "paypal_order_mismatch" }, 400);
      // Keep one request ID across uncertain/network retries, but rotate it after a
      // definitive funding decline so PayPal does not replay the previous 422.
      const captureRequestId = saved.capture_request_id || crypto.randomUUID();
      if (!saved.capture_request_id) {
        saved.capture_request_id = captureRequestId;
        await env.PROJECT_STORAGE.put(orderKey, JSON.stringify(saved), { httpMetadata: { contentType: "application/json" } });
      }
      const captured = await fetch(host + "/v2/checkout/orders/" + encodeURIComponent(saved.order_id) + "/capture", {
        method: "POST",
        headers: { authorization: "Bearer " + access, "content-type": "application/json", prefer: "return=representation", "PayPal-Request-Id": captureRequestId },
        body: "{}",
      });
      const result = await captured.json() as {
        name?: string; message?: string; debug_id?: string;
        payer?: { payer_id?: string; email_address?: string; name?: { given_name?: string; surname?: string } };
        details?: Array<{ issue?: string; description?: string }>;
        status?: string;
        purchase_units?: Array<{ payments?: { captures?: Array<{ status?: string; amount?: { value?: string; currency_code?: string }; id?: string }> } }>;
      };
      if (!captured.ok) {
        const issue = result.details?.find(detail => typeof detail.issue === "string")?.issue ?? null;
        const failureStatus = issue?.includes("DECLINED") ? "declined" : "failed";
        const failedAt = new Date().toISOString();
        let buyer = result.payer ? {
          payer_id: result.payer.payer_id ?? null,
          email: result.payer.email_address ?? null,
          name: [result.payer.name?.given_name, result.payer.name?.surname].filter(Boolean).join(" ") || null,
        } : page.buyer ?? null;
        // PayPal may omit payer details from a failed capture response. Look up
        // the approved order so declined attempts can still identify the buyer.
        if (!buyer) {
          try {
            const orderLookup = await fetch(host + "/v2/checkout/orders/" + encodeURIComponent(saved.order_id), {
              headers: { authorization: "Bearer " + access },
            });
            if (orderLookup.ok) {
              const orderDetails = await orderLookup.json() as { payer?: typeof result.payer };
              if (orderDetails.payer) buyer = {
                payer_id: orderDetails.payer.payer_id ?? null,
                email: orderDetails.payer.email_address ?? null,
                name: [orderDetails.payer.name?.given_name, orderDetails.payer.name?.surname].filter(Boolean).join(" ") || null,
              };
            }
          } catch { /* Keep the attempt even when the buyer lookup is unavailable. */ }
        }
        const event = {
          type: failureStatus === "declined" ? "paypal.capture.declined" : "paypal.capture.failed",
          status: failureStatus, checkout_id: id, account_id: page.account_id,
          paypal_order_id: saved.order_id, paypal_request_id: captureRequestId,
          issue, debug_id: result.debug_id ?? null, http_status: captured.status,
          message: result.message ?? null, occurred_at: failedAt,
        };
        // Store payment outcomes and buyer identity, never card or funding details.
        await env.PROJECT_STORAGE.put(keyFor(page.account_id, "events/paypal-" + id + "-" + captureRequestId), JSON.stringify(event), { httpMetadata: { contentType: "application/json" } });
        await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify({
          ...page, buyer, paypal_last_capture_failure: { issue, debug_id: result.debug_id ?? null, status: failureStatus, occurred_at: failedAt },
        }), { httpMetadata: { contentType: "application/json" } });
        // Rotate only after definitive client-side failures. Preserve the request
        // ID for 5xx responses where PayPal may have completed the capture.
        if (captured.status >= 400 && captured.status < 500) {
          saved.capture_request_id = null;
          await env.PROJECT_STORAGE.put(orderKey, JSON.stringify(saved), { httpMetadata: { contentType: "application/json" } });
        }
        return json({
          ok: false,
          error: failureStatus === "declined" ? "paypal_instrument_declined" : "paypal_capture_failed",
          paypal_issue: issue, paypal_debug_id: result.debug_id ?? null, paypal_status: captured.status,
        }, failureStatus === "declined" ? 409 : 502);
      }
      const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
      if (result.status !== "COMPLETED" || capture?.status !== "COMPLETED" || capture.amount?.currency_code !== "USD" || Number(capture.amount.value) !== Number(page.amount_usd)) return json({ error: "paypal_payment_not_completed" }, 409);
      const committed = await commitInventory(env, page, saved.order_id, "paypal");
      const inventory_status = committed.ok ? "queued_for_tinycore_sync" : "needs_review";
      const paidAt = new Date().toISOString();
      const updated = { ...page, status: "paid", inventory_status, order_id: committed.order_id ?? null, payment_method: "paypal", paypal_order_id: saved.order_id, paypal_capture_id: capture.id ?? null, paid_at: paidAt, buyer: result.payer ? { payer_id: result.payer.payer_id ?? null, email: result.payer.email_address ?? null, name: [result.payer.name?.given_name, result.payer.name?.surname].filter(Boolean).join(" ") || null } : page.buyer ?? null };
      await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
      const delivery = await acceptQuotedDelivery(env, id);
      return json({ ok: true, status: "paid", inventory_status, order_id: committed.order_id ?? null, capture_id: capture.id ?? null, delivery });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  if (historyMatch && request.method === "GET") {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    const prefix = `accounts/${accountId}/payments/`;
    const checkouts: any[] = [];
    const events: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.PROJECT_STORAGE.list({ prefix, limit: 1000, cursor });
      for (const object of page.objects) {
        if (!object.key.endsWith(".json")) continue;
        const suffix = object.key.slice(prefix.length);
        if (!suffix.startsWith("checkout-") && !suffix.startsWith("events/")) continue;
        const record = await readJson<any>(env.PROJECT_STORAGE, object.key);
        if (!record || record.account_id !== accountId) continue;
        if (suffix.startsWith("checkout-")) checkouts.push(record);
        else events.push(record);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // Backfill buyer identity for older PayPal checkouts created before the
    // merchant ledger stored payer details. Limit lookups per request and cache
    // one OAuth token per mode so dashboard refreshes stay bounded.
    const buyerTokens = new Map<string, { host: string; access: string }>();
    let buyerLookups = 0;
    for (const checkout of checkouts) {
      if (buyerLookups >= 10) break;
      const mode = checkout.paypal_mode === "live" ? "live" : checkout.paypal_mode === "sandbox" ? "sandbox" : null;
      if (checkout.buyer || checkout.buyer_lookup_at || !checkout.paypal_order_id || !mode) continue;
      try {
        let auth = buyerTokens.get(mode);
        if (!auth) {
          const credentials = await getPaypalCredentials(env, accountId, mode);
          if (!credentials) continue;
          const host = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
          auth = { host, access: await paypalAccessToken(host, credentials) };
          buyerTokens.set(mode, auth);
        }
        buyerLookups++;
        const lookup = await fetch(auth.host + "/v2/checkout/orders/" + encodeURIComponent(checkout.paypal_order_id), {
          headers: { authorization: "Bearer " + auth.access },
        });
        if (!lookup.ok) {
          if (lookup.status === 404) {
            checkout.buyer_lookup_at = new Date().toISOString();
            await env.PROJECT_STORAGE.put(keyFor(accountId, "checkout-" + checkout.id), JSON.stringify(checkout), { httpMetadata: { contentType: "application/json" } });
          }
          continue;
        }
        const orderDetails = await lookup.json() as { status?: string; payer?: { payer_id?: string; email_address?: string; name?: { given_name?: string; surname?: string } } };
        if (orderDetails.payer) {
          checkout.buyer = {
            payer_id: orderDetails.payer.payer_id ?? null,
            email: orderDetails.payer.email_address ?? null,
            name: [orderDetails.payer.name?.given_name, orderDetails.payer.name?.surname].filter(Boolean).join(" ") || null,
          };
          checkout.buyer_lookup_at = new Date().toISOString();
        } else if (orderDetails.status === "APPROVED" || orderDetails.status === "COMPLETED") {
          checkout.buyer_lookup_at = new Date().toISOString();
        } else {
          continue; // Buyer has not approved this order yet; retry on a later dashboard load.
        }
        await env.PROJECT_STORAGE.put(keyFor(accountId, "checkout-" + checkout.id), JSON.stringify(checkout), { httpMetadata: { contentType: "application/json" } });
      } catch { /* Keep the history request available if PayPal enrichment is unavailable. */ }
    }
    const eventByCheckout = new Map<string, any[]>();
    for (const event of events) {
      const id = typeof event.checkout_id === "string" ? event.checkout_id : "";
      if (!id) continue;
      const list = eventByCheckout.get(id) ?? [];
      list.push(event); eventByCheckout.set(id, list);
    }
    const payments = checkouts.map(checkout => {
      const timeline = (eventByCheckout.get(checkout.id) ?? []).map(event => ({
        type: event.type, status: event.status ?? (event.type === "paypal.capture.declined" ? "declined" : "event"),
        occurred_at: event.occurred_at ?? event.created_at, message: event.message ?? null,
        paypal_issue: event.issue ?? null, paypal_debug_id: event.debug_id ?? null, amount: event.amount ?? null,
      })).sort((a,b) => String(a.occurred_at ?? "").localeCompare(String(b.occurred_at ?? "")));
      if (checkout.paid_at && !timeline.some(event => event.status === "completed")) timeline.push({ type: "payment.completed", status: "completed", occurred_at: checkout.paid_at, message: null, paypal_issue: null, paypal_debug_id: null });
      if (checkout.paypal_last_capture_failure && !timeline.some(event => event.status === "declined")) timeline.push({
        type: "paypal.capture.declined", status: "declined", occurred_at: checkout.paypal_last_capture_failure.occurred_at,
        message: "PayPal declined the buyer's funding source.", paypal_issue: checkout.paypal_last_capture_failure.issue ?? null,
        paypal_debug_id: checkout.paypal_last_capture_failure.debug_id ?? null,
      });
      const status = checkout.status === "paid" ? "completed" : checkout.paypal_last_capture_failure ? (checkout.paypal_last_capture_failure.status ?? "declined") :
        Date.parse(checkout.expires_at ?? "") < Date.now() && checkout.status === "pending" ? "expired" : checkout.status ?? "pending";
      return {
        checkout_id: checkout.id, status, amount: checkout.amount_usd, currency: "USD",
        payment_method: checkout.payment_method ?? (checkout.paypal_mode ? "paypal" : "unknown"),
        environment: checkout.paypal_mode ?? "not_applicable",
        description: checkout.description ?? "", items: checkout.items ?? [],
        buyer: checkout.buyer ?? null, created_at: checkout.created_at, paid_at: checkout.paid_at ?? null,
        refunded_amount: checkout.refunded_amount_usd ?? "0.00",
        paypal_order_id: checkout.paypal_order_id ?? null, paypal_capture_id: checkout.paypal_capture_id ?? null,
        order_id: checkout.order_id ?? null, timeline,
      };
    }).sort((a,b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    return json({ ok: true, payments, count: payments.length, supported_statuses: ["pending","completed","declined","failed","expired","refunded","partially_refunded","reversed","voided"] });
  }
  if (settingsMatch || createMatch) {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    const settingsKey = keyFor(accountId, "settings");
    if (settingsMatch && request.method === "GET") return json({ ok: true, settings: await readJson(env.PROJECT_STORAGE, settingsKey) ?? { wallet_address: "", paypal_url: "", crypto_enabled: false, paypal_enabled: false } });
    if (settingsMatch && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || (body.wallet_address !== "" && !addressOk(body.wallet_address)) || (body.paypal_url !== "" && !validPayPalUrl(body.paypal_url)) ||
        typeof body.crypto_enabled !== "boolean" || typeof body.paypal_enabled !== "boolean" ||
        (body.crypto_enabled && !addressOk(body.wallet_address)) || (body.paypal_enabled && !validPayPalUrl(body.paypal_url) && !await readJson(env.PROJECT_STORAGE, keyFor(accountId, "paypal-credentials")))) return json({ error: "invalid_payment_settings" }, 400);
      const settings = { wallet_address: body.wallet_address, paypal_url: body.paypal_url, crypto_enabled: body.crypto_enabled, paypal_enabled: body.paypal_enabled, network: "Base", token: "USDC", updated_at: new Date().toISOString() };
      await env.PROJECT_STORAGE.put(settingsKey, JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, settings });
    }
    if (createMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { amount_usd?: unknown; description?: unknown } | null;
      const amount = typeof body?.amount_usd === "string" ? body.amount_usd : String(body?.amount_usd ?? "");
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || typeof body?.description !== "string" || body.description.trim().length < 1 || body.description.length > 120) return json({ error: "invalid_checkout_details" }, 400);
      const settings = await readJson<any>(env.PROJECT_STORAGE, settingsKey);
      if (!settings || (!settings.crypto_enabled && !settings.paypal_enabled)) return json({ error: "no_payment_method_configured" }, 409);
      const id = crypto.randomUUID();
      const activeCredentials = await getPaypalCredentials(env, accountId);
      const record = { id, account_id: accountId, paypal_mode: activeCredentials?.mode ?? null, amount_usd: Number(amount).toFixed(2), description: body.description.trim(), status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
      await env.PROJECT_STORAGE.put(keyFor(accountId, "checkout-" + id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
      await env.PROJECT_STORAGE.put("payment-index/" + id + ".json", JSON.stringify({ account_id: accountId }), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, checkout: record, url: new URL("/checkout.html?id=" + id, url.origin).toString() }, 201);
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (publicMatch && request.method === "GET") {
    const id = publicMatch[1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(page.account_id, "settings"));
    const selectedMode = page.paypal_mode === "live" ? "live" : page.paypal_mode === "sandbox" ? "sandbox" : undefined;
    const paypalConfig = selectedMode
      ? await readJson<{ client_id: string; mode: string }>(env.PROJECT_STORAGE, keyFor(page.account_id, "paypal-credentials-" + selectedMode))
      : await readJson<{ client_id: string; mode: string }>(env.PROJECT_STORAGE, keyFor(page.account_id, "paypal-credentials"));
    return json({ ok: true, checkout: page, methods: { crypto: Boolean(settings?.crypto_enabled), paypal: Boolean(settings?.paypal_enabled && paypalConfig) }, paypal: paypalConfig ? { client_id: paypalConfig.client_id, mode: paypalConfig.mode } : null, wallet_address: settings?.crypto_enabled ? settings.wallet_address : null, paypal_url: settings?.paypal_enabled ? settings.paypal_url : null, network: "Base", token: "USDC", token_contract: USDC_BASE });
  }
  if (verifyMatch && request.method === "POST") {
    const id = verifyMatch[1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    if (page.status === "paid") return json({ ok: true, status: "paid" });
    if (Date.now() > Date.parse(page.expires_at)) return json({ error: "checkout_expired" }, 410);
    const body = await request.json().catch(() => null) as { transaction_hash?: unknown } | null;
    const hash = body?.transaction_hash;
    if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return json({ error: "invalid_transaction_hash" }, 400);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(page.account_id, "settings"));
    if (!settings?.crypto_enabled || !addressOk(settings.wallet_address)) return json({ error: "crypto_not_enabled" }, 409);
    const rpc = await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }) });
    if (!rpc.ok) return json({ error: "network_verification_unavailable" }, 502);
    const result = await rpc.json() as { result?: { status?: string; logs?: Array<{ address?: string; topics?: string[]; data?: string }> } | null };
    const receipt = result.result;
    if (!receipt) return json({ ok: true, status: "pending", message: "Transaction not yet confirmed." });
    if (receipt.status !== "0x1") return json({ error: "transaction_failed" }, 400);
    const recipientTopic = "0x" + settings.wallet_address.slice(2).toLowerCase().padStart(64, "0");
    const usedKey = "payment-used-transactions/" + hash.toLowerCase() + ".json";
    if (await env.PROJECT_STORAGE.head(usedKey)) return json({ error: "transaction_already_used" }, 409);
    const expected = BigInt(Math.round(Number(page.amount_usd) * 1_000_000));
    const paid = (receipt.logs ?? []).some(log => log.address?.toLowerCase() === USDC_BASE.toLowerCase() && log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics?.[2]?.toLowerCase() === recipientTopic && typeof log.data === "string" && BigInt(log.data) >= expected);
    if (!paid) return json({ error: "matching_usdc_transfer_not_found" }, 400);
    const committed = await commitInventory(env, page, hash, "usdc");
    const inventory_status = committed.ok ? "queued_for_tinycore_sync" : "needs_review";
    const updated = { ...page, status: "paid", inventory_status, order_id: committed.order_id ?? null, transaction_hash: hash, paid_at: new Date().toISOString(), network: "Base", token: "USDC" };
    await env.PROJECT_STORAGE.put(usedKey, JSON.stringify({ checkout_id: id, account_id: page.account_id }), { httpMetadata: { contentType: "application/json" } });
    await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
    const delivery = await acceptQuotedDelivery(env, id);
    return json({ ok: true, status: "paid", inventory_status, transaction_hash: hash, delivery });
  }
  return json({ error: "method_not_allowed" }, 405);
}
async function findCheckout(bucket: R2Bucket, id: string): Promise<any | null> {
  const index = await readJson<{ account_id?: string }>(bucket, "payment-index/" + id + ".json");
  if (!index?.account_id || !accountOk(index.account_id)) return null;
  return readJson(bucket, keyFor(index.account_id, "checkout-" + id));
}


async function encryptCredentials(secret: string, credentials: { client_id: string; client_secret: string; mode: "sandbox" | "live" }): Promise<{ iv: string; ciphertext: string }> {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("PAYMENTS_ENCRYPTION_KEY must be base64-encoded 32-byte key");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(credentials)));
  return { iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))) };
}
async function decryptCredentials(secret: string, record: { iv: string; ciphertext: string }): Promise<{ client_id: string; client_secret: string; mode: "sandbox" | "live" }> {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(record.iv), c => c.charCodeAt(0)) }, key, Uint8Array.from(atob(record.ciphertext), c => c.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function getPaypalCredentials(env: PaymentEnv, accountId: string, mode?: "sandbox" | "live") {
  if (!env.PAYMENTS_ENCRYPTION_KEY) return null;
  const suffix = mode ? "paypal-credentials-" + mode : "paypal-credentials";
  let record = await readJson<{ iv: string; ciphertext: string }>(env.PROJECT_STORAGE, keyFor(accountId, suffix));
  if ((!record?.iv || !record.ciphertext) && mode) {
    record = await readJson<{ iv: string; ciphertext: string }>(env.PROJECT_STORAGE, keyFor(accountId, "paypal-credentials"));
  }
  if (!record?.iv || !record.ciphertext) return null;
  try {
    const credentials = await decryptCredentials(env.PAYMENTS_ENCRYPTION_KEY, record);
    if (mode && credentials.mode !== mode) return null;
    return credentials;
  } catch { return null; }
}
async function paypalAccessToken(host: string, credentials: { client_id: string; client_secret: string }) {
  const response = await fetch(host + "/v1/oauth2/token", { method: "POST", headers: { authorization: "Basic " + btoa(credentials.client_id + ":" + credentials.client_secret), "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const data = await response.json() as { access_token?: string };
  if (!response.ok || !data.access_token) throw new Error("PayPal OAuth token request failed");
  return data.access_token;
}
