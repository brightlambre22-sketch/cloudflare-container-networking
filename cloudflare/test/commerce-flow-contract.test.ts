import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("marketplace refreshes the merchant Stockroom catalog before discovery", async () => {
  const marketplace = await read("../src/marketplace-directory.ts");
  const page = await read("../../public/marketplace.html");
  const app = await read("../../public/emporium/js/marketplace-app.js");
  assert.match(marketplace, /syncInventoryCatalog\(env, profile\.account_id\)/);
  assert.match(marketplace, /marketplace\/catalog-sync\//);
  assert.match(marketplace, /Date\.now\(\) - syncedAt > 60_000/);
  assert.match(page, /emporium\/js\/marketplace-app\.js/);
  assert.match(app, /data-add-to-cart/);
  assert.match(app, /api\/payments\/public\/checkout/);
  assert.match(app, /search\.delete\("city"\); search\.delete\("state"\);/);
  assert.match(marketplace, /distance !== null && distance > radius\) continue/);
  assert.doesNotMatch(marketplace, /distance > radius && !postalMatch/);
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
  const app = await read("../../public/emporium/js/checkout-app.js");
  assert.match(payments, /paypalCreateMatch/);
  assert.match(payments, /paypalCaptureMatch/);
  assert.match(checkout, /emporium\/js\/checkout-app\.js/);
  assert.match(app, /window\.paypal\.Buttons/);
  assert.match(app, /\/paypal\/create-order/);
  assert.match(app, /\/paypal\/capture/);
  assert.match(payments, /capture_request_id\s*\|\|\s*crypto\.randomUUID\(\)/);
  assert.match(payments, /PayPal-Request-Id": captureRequestId/);
  assert.match(payments, /paypal\.capture\.declined/);
  assert.match(payments, /paypal\.capture\.failed/);
  assert.match(payments, /failureStatus/);
  assert.match(payments, /v2\/checkout\/orders\//);
  assert.match(payments, /saved\.capture_request_id = null/);
  assert.match(payments, /paypal_last_capture_failure/);
  assert.match(checkout, /payment goes directly to the independent merchant/i);
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

test("commerce and merchant dashboard inline scripts parse", async () => {
  const pages = [
    { html: "../../public/marketplace.html", scripts: ["../../public/emporium/js/marketplace-app.js"] },
    { html: "../../public/checkout.html", scripts: ["../../public/emporium/js/checkout-app.js"] },
    { html: "../../public/merchant-orders.html", scripts: [] },
    { html: "../../public/vm.html", scripts: [] },
  ];
  for (const { html: path, scripts: controllerPaths } of pages) {
    const html = await read(path);
    const inlineScripts = html.split("<script").slice(1)
      .map(tag => tag.slice(tag.indexOf(">") + 1).split("</script>")[0])
      .filter(source => source.trim());
    const controllers = await Promise.all(controllerPaths.map(read));
    const scripts = [...inlineScripts, ...controllers];
    assert.ok(scripts.length > 0, path + " should contain page controller scripts");
    for (const source of scripts) new Script(source, { filename: path });
  }
});

test("merchant payment history is account-scoped and includes checkout attempts, buyer identity, and decline timeline", async () => {
  const payments = await read("../src/payments.ts");
  const dashboard = await read("../../public/merchant-payments.html");
  const orders = await read("../../public/merchant-orders.html");
  assert.match(payments, /\/api\/payments\/history/);
  assert.match(payments, /authenticate\(request, env, accountId\)/);
  assert.ok(payments.includes("accounts/${accountId}/payments/"));
  assert.match(payments, /env\.PROJECT_STORAGE\.list\(\{ prefix, limit: 1000, cursor \}\)/);
  assert.match(payments, /paypal\.capture\.declined/);
  assert.match(payments, /result\.payer\.email_address/);
  assert.match(payments, /result\.payer\.payer_id/);
  assert.match(payments, /buyer_lookup_at/);
  assert.match(payments, /paypal-credentials\"\)\);/);
  assert.match(payments, /credentials\.mode !== mode/);
  assert.match(payments, /buyerLookups >= 10/);
  assert.match(payments, /orderDetails\.status === "APPROVED"/);
  assert.match(payments, /payer\?: \{ payer_id\?: string; email_address\?: string/);
  assert.match(payments, /existingPlain\.client_secret === credentials\.client_secret/);
  assert.match(payments, /reusedWebhook/);
  assert.match(payments, /existingCredential\.webhook_url === webhookUrl/);
  assert.match(payments, /listResponse\.ok/);
  assert.match(payments, /item\.url === webhookUrl/);
  assert.match(payments, /partially_refunded/);
  assert.match(payments, /refunded_amount: checkout\.refunded_amount_usd/);
  assert.match(payments, /amount: event\.amount/);
  assert.match(dashboard, /\["Refunded",Number\(p\.refunded_amount\|\|0\)\s*>0\?money\(p\.refunded_amount\)/);
  assert.match(dashboard, /Net paid/);
  assert.match(dashboard, /Number\(p\.amount\|\|0\)-Number\(p\.refunded_amount\|\|0\)/);
  assert.match(dashboard, /api\/payments\/history/);
  assert.match(dashboard, /loadWebhookStatus/);
  assert.match(dashboard, /webhook-status/);
  assert.match(dashboard, /item\.status\.replaceAll\("_"," "\)/);
  assert.match(dashboard, /Buyer email/);
  assert.match(dashboard, /PayPal payer ID/);
  assert.match(dashboard, /declined/);
  assert.match(dashboard, /<option>failed<\/option>/);
  assert.match(orders, /merchant-payments\.html/);
  const inline = dashboard.split("<script").slice(1).map(tag => tag.slice(tag.indexOf(">") + 1).split("</script>")[0]).filter(s => s.trim());
  for (const source of inline) new Script(source, { filename: "merchant-payments.html" });
});

test("main merchant Studio dashboard exposes and renders authenticated payment history", async () => {
  const page = await read("../../public/studio.html");
  const app = await read("../../public/studio.js");
  assert.match(page, /data-view="payments"/);
  assert.match(page, /id="view-payments"/);
  assert.match(page, /merchant-payment-count/);
  assert.match(app, /api\/payments\/history\?account_id=/);
  assert.match(app, /function loadMerchantPayments/);
  assert.match(app, /function renderMerchantPayments/);
  assert.match(app, /if\(name==='payments'\)void loadMerchantPayments\(\)/);
  assert.match(app, /merchant-payments-refresh/);
  new Script(app, { filename: "studio.js" });
});

test("PayPal webhook lifecycle is signature-verified, idempotent, and merchant-scoped", async () => {
  const payments = await read("../src/payments.ts");
  assert.match(payments, /verify-webhook-signature/);
  assert.match(payments, /paypal-transmission-sig/);
  assert.match(payments, /verification_status !== "SUCCESS"/);
  assert.match(payments, /paypal-webhook-/);
  assert.match(payments, /PAYMENT\.CAPTURE\.REFUNDED/);
  assert.match(payments, /PAYMENT\.CAPTURE\.REVERSED/);
  assert.match(payments, /CHECKOUT\.PAYMENT-APPROVAL\.REVERSED/);
  assert.match(payments, /eventType === "CHECKOUT\.PAYMENT-APPROVAL\.REVERSED" \? resource\.id/);
  assert.match(payments, /partially_refunded/);
  assert.match(payments, /webhook_status = "active"/);
});
