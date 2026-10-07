# Project status: per-node TCP/UDP tunnel integration

## Implemented

- Private GitHub repository with a Wrangler Worker and SQLite-backed Durable Object configuration.
- Public GET /health, bearer-protected GET /v1/nodes, and authenticated /tunnel WebSocket route.
- Separate gateway and test-client tokens and session roles.
- Version 1 binary frame codec in TypeScript and Python with size, version, node ID, and length validation.
- Durable Object routing of bounded frames between the matching client/gateway roles for a node.
- Python gateway client with reconnect, heartbeat, up to 32 outbound TCP streams, exact egress allowlists, and optional Oracle TCP/UDP ingress maps.
- FineProxy SOCKS5 TCP CONNECT and UDP ASSOCIATE helpers; credentials come from Oracle runtime environment variables.
- Node-side agent with loopback-only SOCKS5 TCP CONNECT/UDP ASSOCIATE and separate exact allowlists for inbound TCP and UDP services.
- Optional Oracle public TCP and UDP listeners, each mapping one explicitly configured public port to an allowlisted node target over that node's authenticated tunnel.
- UDP session expiry and bounded TCP/UDP association counts.
- Local SOCKS5 packet/handshake tests using a fake proxy; no live FineProxy endpoint was exercised.
- Loopback TCP echo service, two-stream smoke-test client, and Python codec unit tests.
- Oracle gateway public IP supplied for this project: 141.148.53.68.

## Proof procedure

Deploy the Worker, start gateway/echo_server.py and gateway/client.py on the Oracle host, then run gateway/tcp_smoke.py with the same NODE_ID and CLIENT_TOKEN. The smoke script opens two streams to the loopback echo server and verifies both byte sequences return over the same WebSocket path. Run python -m unittest -v from the gateway directory for codec tests.

## Not production-ready / not implemented

This is an integration prototype, not a VPS replacement. There is no Docker lifecycle manager, automatic private-IP assignment, OS-level network isolation, public-IP verification, admin UI, reconnect-safe stream resumption, robust TCP half-close handling, production token provisioning/rotation, or live end-to-end validation against FineProxy and the Oracle firewall. The default smoke-test destination is intentionally loopback-only. Do not widen the gateway or node allowlists casually: they control where authenticated tunnel peers can connect.

Public TCP/UDP ingress terminates on the Oracle gateway, not Cloudflare or FineProxy. FineProxy must have UDP ASSOCIATE enabled for UDP egress. SOCKS5 UDP is used for outbound datagrams and their replies; it does not provide unsolicited inbound port forwarding. Ingress listeners bind only when their explicit `TCP_INGRESS_MAP` or `UDP_INGRESS_MAP` entry is configured, and node-side allowlists must match the mapped target. This project does not spoof IP addresses, expose Docker remotely, or provide arbitrary shell execution.

## Next milestones

1. Run live TCP and UDP tests against the rotated FineProxy credentials and confirm the provider plan has UDP enabled.
2. Configure and test each Oracle ingress mapping against its node-local service; expose only required ports in both Oracle and cloud firewalls.
3. Add isolated Docker workloads, unique private addresses, OS-level fail-closed egress enforcement, and public-IP verification.
4. Harden stream lifecycle (half-close, per-stream sequencing, bounded queues/backpressure), signed per-component identities, key rotation, metrics, and deployment/recovery tests before production use.

## Plan constraint

The starter uses SQLite-backed Durable Objects supported by Cloudflare Workers Free and does not use Cloudflare Containers. As checked against official docs on 2026-10-07, Durable Objects on Free had 100,000 requests/day and 13,000 GB-s/day, with further operations failing after a free limit is exceeded. WebSocket message accounting and storage quotas also apply. Check current Cloudflare limits before sustained usage. A Replit plan upgrade is not required for this repository.
