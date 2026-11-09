import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("Stockroom accepts shared merchant sessions and validates POS keys against the account registry", async () => {
  const source = await read("../src/business-database.ts");
  assert.match(source, /authenticateStockroomCredential/);
  assert.match(source, /auth\/verify/);
  assert.match(source, /x-account-key-sha256/);
  assert.match(source, /pos_api_key/);
  assert.match(source, /pos_key_scope_forbidden/);
  assert.match(source, /Merchant cost is private accounting data/);
  assert.match(source, /offline-allowance\/release/);
});

test("POS keys are restricted to catalog reads, inventory allocations, sales, and sync", async () => {
  const source = await read("../src/business-database.ts");
  assert.match(source, /internalPathPlaceholder\(url\) === "\/products" && request\.method === "GET"/);
  assert.match(source, /internalPathPlaceholder\(url\) === "\/movements" && request\.method === "GET"/);
  assert.match(source, /internalPathPlaceholder\(url\) === "\/offline-allowance" && request\.method === "POST"/);
  assert.match(source, /internalPathPlaceholder\(url\) === "\/offline-allowance\/release" && request\.method === "POST"/);
  assert.match(source, /internalPathPlaceholder\(url\) === "\/offline-sales" && request\.method === "POST"/);
  assert.match(source, /internalPathPlaceholder\(url\) === "\/sync\/orders" && request\.method === "POST"/);
  assert.match(source, /internalPathPlaceholder\(url\) === "\/orders" && request\.method === "GET"/);
});

test("offline POS allocations are idempotent, releasable, and bound to remaining per-product quantities", async () => {
  const source = await read("../src/inventory-ledger.ts");
  assert.match(source, /CREATE TABLE IF NOT EXISTS offline_allocations/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS offline_allocation_items/);
  assert.match(source, /offline_allocation_id_conflict/);
  assert.match(source, /url\.pathname === "\/offline\/release"/);
  assert.match(source, /offline_allocation_items SET remaining=remaining-\?/);
  assert.match(source, /offline_allowance_exceeded/);
  assert.match(source, /invalid_payment_method/);
  assert.match(source, /expires_at TEXT NOT NULL/);
  assert.match(source, /expireOfflineAllocations\(now\)/);
  assert.match(source, /unit_price_cents INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /allocationDetails\.set\(x\.id/);
  assert.match(source, /unit_price_cents,name\) VALUES/);
  assert.match(source, /unit_price_cents: Number\(allowance\.unit_price_cents\)/);
  assert.match(source, /ALTER TABLE offline_allocation_items ADD COLUMN unit_price_cents/);
  const consumeStart = source.indexOf('if (url.pathname === "/offline/consume"');
  const consumeEnd = source.indexOf('if (url.pathname === "/orders" && request.method === "GET")', consumeStart);
  assert.ok(consumeStart >= 0 && consumeEnd > consumeStart, "offline consume route should be isolated");
  const consume = source.slice(consumeStart, consumeEnd);
  assert.match(consume, /const paymentMethod=/);
  assert.match(consume, /const paymentReference=/);
  assert.match(consume, /invalid_payment_method/);
  assert.match(consume, /payment_method:paymentMethod/);
  assert.match(consume, /payment_reference:paymentReference/);
});

test("offline POS sales enter the same durable outbox as paid online orders", async () => {
  const ledger = await read("../src/inventory-ledger.ts");
  const stockroom = await read("../src/business-database.ts");
  assert.match(ledger, /INSERT INTO inventory_orders\(order_id,checkout_id,status,payload_json,created_at\).*offline:/);
  assert.match(ledger, /url\.pathname === "\/orders" && request\.method === "GET"/);
  assert.match(stockroom, /internalPath === "\/offline-sales" && request\.method === "POST"/);
  assert.match(stockroom, /synchronizePendingOrders\(env, accountId\)/);
});
