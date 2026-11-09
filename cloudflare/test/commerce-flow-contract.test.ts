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
