# Cloudflare Container Networking

An experimental Cloudflare Worker project for authenticated WebSocket tunneling and related headless-v86 feasibility work. The repository contains a limited TCP relay proof and separate experimental work toward running a Tiny Core Linux guest inside Workerd.

**Important:** this repository does not provision or include Oracle Cloud, an Oracle VM, a VPS, or a Linux gateway host. It does not require Oracle as a provider. The TCP relay proof does require a separately operated Linux gateway process; you must provide and manage that host yourself if you want to run that proof.

## Current status

### TCP tunnel proof

Implemented in the repository's Worker and gateway code:

- Worker health endpoint and authenticated WebSocket tunnel roles for gateway and client.
- Hibernatable Durable Object routing bounded binary frames between matching roles for a node.
- Versioned TypeScript/Python frame codec.
- Python gateway client with reconnect/heartbeat, multiple TCP streams, and an explicit destination allowlist.
- Local TCP echo server, two-stream smoke test, and Python codec unit tests.
- Wrangler configuration for SQLite-backed Durable Objects.

This is a limited TCP proof, not a general-purpose network service or a VPS replacement. The sample gateway allowlist defaults to 127.0.0.1:9000. Do not broaden it without understanding that it controls which destinations a client can ask the gateway to connect to.

### Headless Linux / v86 experiment

The branch [test/headless-v86-network-snapshot-roundtrip](https://github.com/brightlambre22-sketch/cloudflare-container-networking/tree/test/headless-v86-network-snapshot-roundtrip) contains experimental work on loading v86 in a Worker-compatible environment and verifying snapshot storage. It is **not a production-ready headless Linux runtime**.

At the time of writing:

- POST /v1/runtime/preflight checks the saved snapshot's manifest/chunks and can optionally attempt to compile the v86 WASM asset.
- Preflight explicitly reports headless_linux_execution: not_implemented; it does not boot Linux, restore a snapshot into a running guest, or execute guest shell commands.
- A successful snapshot storage/read-back check is not proof that Linux boots or that the guest can run inside Workerd.
- Full headless acceptance still requires a real guest boot, guest command execution, snapshot save/read-back verification, and restore/marker verification in the target runtime.
- Do not treat the draft snapshot round-trip integration as validated, and do not merge or deploy it as working functionality without successful acceptance tests.

Useful starting points:

- [Headless v86 experiment branch](https://github.com/brightlambre22-sketch/cloudflare-container-networking/tree/test/headless-v86-network-snapshot-roundtrip)
- [Worker API implementation](https://github.com/brightlambre22-sketch/cloudflare-container-networking/blob/main/cloudflare/src/index.ts)
- [Workerd/v86 compatibility entry](https://github.com/brightlambre22-sketch/cloudflare-container-networking/blob/test/headless-v86-network-snapshot-roundtrip/cloudflare/src/headless-v86-entry.ts)
- [Draft snapshot read-back verification PR](https://github.com/brightlambre22-sketch/cloudflare-container-networking/pull/52)

## Architecture and limitations

- Cloudflare Workers provides the HTTP/WebSocket control layer and Durable Object coordination.
- The current TCP tunnel proof uses a separately operated Linux gateway to open allowlisted outbound TCP connections. This repository does not create or manage that host.
- The headless v86 work is an experiment; do not assume that a Worker API can currently boot and execute Linux headlessly.
- UDP transport, Docker lifecycle management, container IP assignment, proxy adapters, egress enforcement, public-IP verification, public service ingress, and production key provisioning/rotation are not implemented as a complete production system.
- Workers HTTP/WebSocket ingress should not be treated as arbitrary public TCP/UDP ingress. No IP spoofing is used.

## Develop locally

Requirements: Node.js/npm for the Worker and Python for the gateway proof.

~~~sh
cd cloudflare
npm install
cp .dev.vars.example .dev.vars
# Set disposable local-only values in cloudflare/.dev.vars.
npm run dev
~~~

For a Worker bundle/configuration check:

~~~sh
cd cloudflare
npm run check
~~~

For the gateway codec tests:

~~~sh
cd gateway
python -m unittest -v
~~~

To run the TCP echo proof, on a Linux host that you manage yourself, install the dependencies from gateway/requirements.txt, then run gateway/echo_server.py and gateway/client.py; run gateway/tcp_smoke.py with matching test configuration. Use the actual Worker URL and separate, randomly generated TUNNEL_TOKEN and CLIENT_TOKEN values. Keep tokens out of source control, logs, and chat.

## Cloudflare limits and deployment

Cloudflare plan quotas and runtime restrictions apply; check the current Cloudflare documentation before sustained use. This repository's Worker uses Durable Objects and does not depend on Cloudflare Containers. The headless v86 experiment must pass its target-runtime boot and execution tests before it can be considered feasible for production.

Do not deploy experimental headless changes to production solely because a build or snapshot integrity check passes. A build, WASM compile, or valid R2 snapshot is not a substitute for a successful guest boot and execution test.
