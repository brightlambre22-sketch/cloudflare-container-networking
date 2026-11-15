import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const registry = readFileSync(new URL("../src/node-registry.ts", import.meta.url), "utf8");
const tinyRunner = readFileSync(new URL("../../runner/tinycore/cloudflare-runner.sh", import.meta.url), "utf8");
const tinyBootstrap = readFileSync(new URL("../../runner/tinycore/bootstrap.sh", import.meta.url), "utf8");
const containerEntrypoint = readFileSync(new URL("../container/myst-entrypoint.sh", import.meta.url), "utf8");
const compose = readFileSync(new URL("../../runner/amd64/docker-compose.yml", import.meta.url), "utf8");
const shield = readFileSync(new URL("../../public/shield.html", import.meta.url), "utf8");
const home = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

test("node inventory and creation require the configured admin credential", () => {
  const route = worker.match(/if \(url\.pathname === "\/v1\/nodes"\)[\s\S]*?\n    }/);
  assert.ok(route, "node collection route exists");
  assert.match(route[0], /!env\.ADMIN_ACCESS_KEY/);
  assert.match(route[0], /adminAuthorized\(request, env\)/);
  assert.ok(route[0].indexOf("adminAuthorized") < route[0].indexOf("registry.fetch"));
});

test("node status and heartbeat use per-node credentials; lifecycle changes stay admin-only", () => {
  assert.match(worker, /async function nodeAgentAuthorized\(request: Request, env: Env, nodeId: string\)/);
  assert.match(worker, /\/v1\/nodes\/\(\[\^\/\]\+\)\/runtime/);
  assert.match(worker, /action === "heartbeat" \? !agent : \(!admin && !agent\)/);
  assert.match(worker, /if \(request\.method !== "POST" \|\| !admin\)/);
  assert.match(worker, /\/v1\/nodes\/\(\[\^\/\]\+\)\/agent-token/);
});

test("node credentials are random, hashed at rest, verified, and rotatable", () => {
  assert.match(registry, /const agentToken = randomToken\(\)/);
  assert.match(registry, /put\("agent-token:" \+ nodeId, await sha256\(agentToken\)\)/);
  assert.match(registry, /\/node\/\(\[\^\/\]\+\)\/authorize/);
  assert.match(registry, /constantTimeEqual\(expected, supplied\)/);
  assert.match(registry, /\/node\/\(\[\^\/\]\+\)\/rotate-token/);
  assert.doesNotMatch(registry, /put\("agent-token:" \+ nodeId, agentToken\)/);
});

test("Tiny Core and amd64 runners authenticate control-plane traffic", () => {
  assert.match(tinyRunner, /NODE_AGENT_TOKEN=.*NODE_AGENT_TOKEN/);
  assert.match(tinyRunner, /Authorization: Bearer \$\{NODE_AGENT_TOKEN\}/);
  assert.match(tinyBootstrap, /NODE_AGENT_TOKEN/);
  assert.match(containerEntrypoint, /NODE_AGENT_TOKEN/);
  assert.match(containerEntrypoint, /Authorization: Bearer \$NODE_AGENT_TOKEN/);
});

test("amd64 runtime receives cgroup-backed resource limits and reduced privileges", () => {
  assert.match(compose, /cpus: \$\{NODE_CPU_LIMIT:-2\.0\}/);
  assert.match(compose, /mem_limit: \$\{NODE_MEMORY_LIMIT:-2g\}/);
  assert.match(compose, /pids_limit: \$\{NODE_PIDS_LIMIT:-512\}/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:[\s\S]*?- ALL/);
});

test("Shield marketing distinguishes planned work from current controls", () => {
  assert.match(shield, /early-stage initiative, not a currently available managed security service/i);
  assert.match(shield, /not a complete security program/i);
  assert.match(shield, /per-merchant isolation/i);
  assert.match(shield, /cgroup-backed CPU, memory, and process limits/i);
  assert.match(home, /href="\/shield\.html"/);
});
