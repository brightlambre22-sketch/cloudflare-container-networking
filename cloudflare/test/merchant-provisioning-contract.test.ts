import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path: string) =>
  readFile(new URL(path, import.meta.url), "utf8");

test("merchant signup enforces the eight-character password minimum", async () => {
  const [worker, registry] = await Promise.all([
    source("../src/index.ts"),
    source("../src/account-registry.ts"),
  ]);
  assert.match(worker, /password\.length < 8\s*\|\| password\.length > 128/);
  assert.match(registry, /password\.length < 8\s*\|\| password\.length > 128/);
});

test("merchant signup creates an account-scoped key and initializes Stockroom", async () => {
  const worker = await source("../src/index.ts");
  assert.match(worker, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(worker, /api_key_sha256:\s*apiKeyHash/);
  assert.match(worker, /businessDatabaseFetch\(env, accountId, "initialize"/);
  assert.match(worker, /ACCOUNT_PROVISIONER\.get\(env\.ACCOUNT_PROVISIONER\.idFromName\(accountId\)\)/);
});

test("Stockroom is account-isolated and has a Cloudflare fallback", async () => {
  const stockroom = await source("../src/business-database.ts");
  assert.match(stockroom, /env\.STOCKROOM_ORIGIN && env\.STOCKROOM_GATEWAY_TOKEN/);
  assert.match(stockroom, /env\.BUSINESS_DATABASE\.get\(env\.BUSINESS_DATABASE\.idFromName\(accountId\)\)/);
  assert.match(stockroom, /store_catalog_sync_unavailable/);
});

test("an empty public catalog retries Stockroom synchronization", async () => {
  const stockroom = await source("../src/business-database.ts");
  assert.match(stockroom, /if \(!catalog\.products\?\.length\)/);
  assert.match(stockroom, /await syncInventoryCatalog\(env, accountId\)/);
});

test("merchant product images are stored in account-scoped R2 paths", async () => {
  const stockroom = await source("../src/business-database.ts");
  assert.match(stockroom, /merchants\/\$\{accountId2\}\/products\//);
  assert.match(stockroom, /env\.PROJECT_STORAGE\.put/);
});
test("Wrangler declares all production Stockroom and merchant storage bindings", async () => {
  const config = await source("../wrangler.toml");
  for (const binding of [
    'name = "BUSINESS_DATABASE"',
    'name = "INVENTORY_LEDGER"',
    'name = "WISP_RELAY"',
    'binding = "PROJECT_STORAGE"',
  ]) assert.ok(config.includes(binding), `Missing binding: ${binding}`);
});
