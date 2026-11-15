import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const registry = readFileSync(new URL("../src/node-registry.ts", import.meta.url), "utf8");
const tinyRunner = readFileSync(new URL("../../runner/tinycore/cloudflare-runner.sh", import.meta.url), "utf8");
const tinyBootstrap = readFileSync(new URL("../../runner/tinycore/bootstrap.sh", import.meta.url), "utf8");
const tinyNodeEnv = readFileSync(new URL("../../runner/tinycore/node.env.example", import.meta.url), "utf8");
const containerEntrypoint = readFileSync(new URL("../container/myst-entrypoint.sh", import.meta.url), "utf8");
const health = readFileSync(new URL("../container/health.py", import.meta.url), "utf8");
const compose = readFileSync(new URL("../../runner/amd64/docker-compose.yml", import.meta.url), "utf8");
const shield = readFileSync(new URL("../../public/shield.html", import.meta.url), "utf8");
const home = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

test("node inventory and creation require the configured admin credential", () => {
  const start = worker.indexOf('if (url.pathname === "/v1/nodes")');
  const end = worker.indexOf("const agentTokenMatch", start);
  assert.ok(start >= 0 && end > start);
  const route = worker.slice(start, end);
  assert.ok(route.includes("!env.ADMIN_ACCESS_KEY"));
  assert.ok(route.includes("adminAuthorized(request, env)"));
  assert.ok(route.indexOf("adminAuthorized") < route.indexOf("registry.fetch"));
});

test("node status and heartbeat use per-node credentials; lifecycle changes stay admin-only", () => {
  const start = worker.indexOf("const runtimeMatch = url.pathname.match(");
  const end = worker.indexOf("const nodeMatch = url.pathname.match(", start);
  assert.ok(start >= 0 && end > start);
  const route = worker.slice(start, end);
  assert.ok(route.includes("nodeAgentAuthorized(request, env, nodeId)"));
  assert.ok(route.includes('action === "heartbeat" ? !agent : (!admin && !agent)'));
  assert.ok(route.includes('request.method !== "POST" || !admin'));
  assert.ok(worker.includes("agent-token"));
});

test("node credentials are random, hashed at rest, verified, and rotatable", () => {
  assert.ok(registry.includes("const agentToken = randomToken()"));
  assert.ok(registry.includes('put("agent-token:" + nodeId, await sha256(agentToken))'));
  assert.ok(registry.includes("authorizeMatch"));
  assert.ok(registry.includes("constantTimeEqual(expected, supplied)"));
  assert.ok(registry.includes("rotateMatch"));
  assert.ok(!registry.includes('put("agent-token:" + nodeId, agentToken)'));
});

test("Tiny Core and amd64 runners authenticate control-plane traffic", () => {
  assert.ok(tinyRunner.includes("NODE_AGENT_TOKEN"));
  assert.ok(tinyRunner.includes('Authorization: Bearer ${NODE_AGENT_TOKEN}'));
  assert.ok(tinyBootstrap.includes("NODE_AGENT_TOKEN"));
  assert.ok(tinyBootstrap.includes(". \"$NODE_ENV_FILE\""));
  assert.ok(tinyNodeEnv.includes("NODE_AGENT_TOKEN="));
  assert.ok(containerEntrypoint.includes("NODE_AGENT_TOKEN"));
  assert.ok(containerEntrypoint.includes("Authorization: Bearer $NODE_AGENT_TOKEN"));
});

test("amd64 runtime receives cgroup-backed resource limits and reduced privileges", () => {
  assert.ok(compose.includes("cpus: ${NODE_CPU_LIMIT:-2.0}"));
  assert.ok(compose.includes("mem_limit: ${NODE_MEMORY_LIMIT:-2g}"));
  assert.ok(compose.includes("pids_limit: ${NODE_PIDS_LIMIT:-512}"));
  assert.ok(compose.includes("no-new-privileges:true"));
  assert.ok(compose.includes("cap_drop:"));
  assert.ok(health.includes('HTTPServer(("127.0.0.1", 8080)'));
});

test("diagnostic routes require admin authentication", () => {
  for (const route of ['/api/vm/oracle-status', '/debug/egress-ip', '/debug/fineproxy-tcp']) {
    const start = worker.indexOf('if (url.pathname === "' + route + '")');
    assert.ok(start >= 0, "route exists: " + route);
    const end = worker.indexOf("\n    }", start);
    const block = worker.slice(start, end);
    assert.ok(block.includes("adminAuthorized(request, env)"), "admin guard: " + route);
  }
});

test("Shield marketing distinguishes planned work from current controls", () => {
  assert.match(shield, /early-stage initiative, not a currently available managed security service/i);
  assert.match(shield, /not a complete security program/i);
  assert.match(shield, /per-merchant isolation/i);
  assert.match(shield, /cgroup-backed CPU, memory, and process limits/i);
  assert.match(home, /href="\/shield\.html"/);
});
