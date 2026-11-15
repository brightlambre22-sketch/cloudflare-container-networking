import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("node inventory and lifecycle routes fail closed for unauthenticated callers", async () => {
  const [worker, registry] = await Promise.all([read("../src/index.ts"), read("../src/node-registry.ts")]);
  const start = worker.indexOf('// Node inventory and lifecycle operations are privileged control-plane APIs.');
  const end = worker.indexOf('if (url.pathname === "/" || url.pathname === "")', start);
  assert.ok(start >= 0 && end > start, "node route block must be present");
  const routes = worker.slice(start, end);

  assert.match(worker, /NODE_CONTROL_TOKEN\?: string/);
  assert.match(routes, /if \(!await adminAuthorized\(request, env\)\) return json\(\{ error: "unauthorized" \}, 401\)/);
  assert.match(routes, /authorized\(request\.headers\.get\("authorization"\), env\.NODE_CONTROL_TOKEN\)/);
  assert.match(routes, /node_control_token_not_configured/);
  assert.match(routes, /action === "start"/);
  assert.match(routes, /action === "stop"/);
  assert.match(routes, /action === "probe"/);
  assert.match(routes, /action === "heartbeat"/);
  assert.match(registry, /unsupported_patch_field/);
  assert.match(registry, /invalid_node_status/);
  assert.match(registry, /invalid_node_runtime/);
  assert.match(registry, /new Set\(\["status", "runtime", "error"\]\)/);
  assert.doesNotMatch(registry, /egress_ip: patch/);

  // Only authenticated routes may reach the registry/runtime Durable Objects.
  const registryList = routes.indexOf('registry.fetch("https://node-registry.internal/list")');
  assert.ok(registryList > routes.indexOf("adminAuthorized(request, env)"));
  const runtimeStatus = routes.indexOf('runtime.fetch("https://node-runtime.internal/status")');
  assert.ok(runtimeStatus > routes.indexOf("authorized(request.headers.get(\"authorization\"), env.NODE_CONTROL_TOKEN)"));
});

test("TinyCore runner requires and sends its dedicated control-plane credential", async () => {
  const [runner, publicRunner, envExample] = await Promise.all([
    read("../../runner/tinycore/cloudflare-runner.sh"),
    read("../../public/runner/tinycore/cloudflare-runner.sh"),
    read("../../runner/tinycore/node.env.example"),
  ]);
  for (const script of [runner, publicRunner]) {
    assert.match(script, /NODE_CONTROL_TOKEN="\$\{NODE_CONTROL_TOKEN:\?Set NODE_CONTROL_TOKEN/);
    assert.match(script, /Authorization: Bearer \$\{NODE_CONTROL_TOKEN\}/);
    assert.match(script, /\/runtime\/heartbeat/);
  }
  assert.equal(runner, publicRunner, "public and source runner copies must remain identical");
  assert.match(envExample, /never persist it here/);
  assert.doesNotMatch(envExample, /^NODE_CONTROL_TOKEN=/m);
  const bootstrap = await read("../../runner/tinycore/browser-bootstrap.sh");
  assert.match(bootstrap, /nohup env NODE_CONTROL_TOKEN=/);
  assert.doesNotMatch(bootstrap, /NODE_CONTROL_TOKEN=\$NODE_CONTROL_TOKEN\\n/);
});
