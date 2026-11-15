# Project status: framed TCP tunnel proof

## Implemented

- Private GitHub repository with a Wrangler Worker and SQLite-backed Durable Object configuration.
- Public GET /health, admin-protected node registry/control routes, per-node 256-bit agent credentials for runner status/heartbeat, and authenticated /tunnel WebSocket route.
- Separate gateway and test-client tokens and session roles.
- Version 1 binary frame codec in TypeScript and Python with size, version, node ID, and length validation.
- Durable Object routing of bounded frames between the matching client/gateway roles for a node.
- Python gateway client with reconnect, heartbeat, up to 32 TCP streams, and an exact TCP_ALLOWLIST. Default allowlist is only 127.0.0.1:9000.
- Loopback TCP echo service, two-stream smoke-test client, and Python codec unit tests.
- Oracle gateway public IP supplied for this project: 141.148.53.68.
- Linux amd64 node container has cgroup-backed CPU, memory, and PID limits plus dropped capabilities and no-new-privileges. These limits apply per node container, not per merchant.

## Proof procedure

Deploy the Worker, start gateway/echo_server.py and gateway/client.py on the Oracle host, then run gateway/tcp_smoke.py with the same NODE_ID and CLIENT_TOKEN. The smoke script opens two streams to the loopback echo server and verifies both byte sequences return over the same WebSocket path. Run python -m unittest -v from the gateway directory for codec tests.

## Not production-ready / not implemented

This is a bounded TCP tunnel proof, not a VPS replacement. There is no UDP datagram transport; no Docker lifecycle manager, container IP assignment, per-container enforcement, proxy adapter, public-IP verification, internet ingress, admin UI, reconnect-safe stream resumption, robust half-close handling, production token provisioning/rotation, or end-to-end test automation. The smoke-test destination is intentionally loopback-only. Do not widen the gateway allowlist casually: it controls where a client with CLIENT_TOKEN can make the gateway connect.

Cloudflare documents HTTP/WebSocket ingress and outbound TCP sockets, while inbound direct TCP is not yet supported. The Linux gateway remains necessary for raw networking. This project does not claim arbitrary UDP support on a Worker HTTP/WebSocket path, does not spoof IP addresses, does not expose Docker remotely, and does not provide arbitrary shell execution.

## Next milestones

1. Harden stream lifecycle: half-close, per-stream sequence checks, idle deadlines, and bounded send queues/backpressure.
2. Add UDP associations only after selecting and testing an actual UDP-capable gateway/proxy path.
3. Add separate per-account Docker workloads, unique namespaces/cgroups, unique private addresses, fail-closed egress enforcement, proxy adapters, and public-IP verification on Oracle Linux.
4. Add signed per-component identities, nonce replay defense, credential rotation automation, operations metrics, and deployment/recovery tests before production use.

## Vampirequid Shield security baseline

The Worker now blocks anonymous node inventory and node lifecycle operations. Admin operations use ADMIN_ACCESS_KEY; each node receives a unique random agent token at creation, while only its SHA-256 digest is stored. Existing nodes require one-time credential rotation and local runner configuration. The Linux Compose runtime applies cgroup resource limits to each node container and reduces Linux capabilities. This is an initial hardening step, not a completed Shield service or a claim of per-merchant isolation.

## Plan constraint

The starter uses SQLite-backed Durable Objects supported by Cloudflare Workers Free and does not use Cloudflare Containers. As checked against official docs on 2026-10-07, Durable Objects on Free had 100,000 requests/day and 13,000 GB-s/day, with further operations failing after a free limit is exceeded. WebSocket message accounting and storage quotas also apply. Check current Cloudflare limits before sustained usage. A Replit plan upgrade is not required for this repository.
