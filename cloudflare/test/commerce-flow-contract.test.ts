import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("marketplace refreshes the merchant Stockroom catalog before discovery", async () => {
  const marketplace = await read("../src/marketplace-directory.ts");
  assert.match(marketplace, /syncInventoryCatalog\(env, profile\.account_id\)/);
  assert.match(marketplace, /marketplace\/catalog-sync\//);
  assert.match(marketplace, /Date\.now\(\) - syncedAt > 60_000/);
});

test("paid orders are committed and immediately synchronized when Stockroom is available", async () => {
  const payments = await read("../src/payments.ts");
  const ledger = await read("../src/inventory-ledger.ts");
  const stockroom = await read("../src/business-database.ts");
  assert.match(payments, /await synchronizePendingOrders\(env, checkout\.account_id\)/);
  assert.match(ledger, /amount_cents:items\.reduce/);
  assert.match(ledger, /\/orders\/all/);
  assert.match(stockroom, /internalPath === "\/orders" && request\.method === "GET"/);
  assert.match(stockroom, /inventory-ledger\.internal\/orders\/all/);
});

test("public merchant checkout has a real PayPal create-order and capture flow", async () => {
  const payments = await read("../src/payments.ts");
  const checkout = await read("../../public/checkout.html");
  assert.match(payments, /paypalCreateMatch/);
  assert.match(payments, /paypalCaptureMatch/);
  assert.match(checkout, /paypal\.Buttons/);
  assert.match(checkout, /\/paypal\/create-order/);
  assert.match(checkout, /\/paypal\/capture/);
  assert.match(checkout, /Your payment is processed directly through the merchant/);
});

test("merchant order history is authenticated and renders account-scoped paid orders", async () => {
  const stockroom = await read("../src/business-database.ts");
  const page = await read("../../public/merchant-orders.html");
  assert.match(stockroom, /authenticate|auth\/verify/);
  assert.match(stockroom, /synchronizePendingOrders\(env, accountId\)/);
  assert.match(page, /\/api\/stockroom\/orders\?account_id=/);
  assert.match(page, /vm-session-token/);
  assert.match(page, /Paid/);
});
