# Cloudflare Container Networking

A Cloudflare-first control and tunnel foundation for per-node networking. The current milestone supports authenticated, multiplexed TCP and UDP over one role-specific WebSocket per node, with an Oracle gateway for explicit public ingress and FineProxy SOCKS5 for outbound TCP/UDP.

## Implemented

- Worker health route, authenticated gateway/client tunnel route, and authenticated live-session listing.
- Hibernatable Durable Object that brokers bounded binary frames between a gateway and client for the same node.
- Versioned frame codec shared by TypeScript and Python.
- Python Oracle gateway that uses FineProxy SOCKS5 CONNECT and UDP ASSOCIATE for allowlisted outbound traffic.
- Node-side agent with a loopback-only SOCKS5 endpoint and allowlisted TCP/UDP public-ingress targets.
- Explicit, optional Oracle TCP/UDP ingress listeners mapped to a per-node tunnel identity.
- Local TCP echo service and a two-stream end-to-end smoke-test client.
- Standard-library SOCKS5 packet/handshake tests; no additional Python runtime dependency.
- Wrangler SQLite-backed Durable Object configuration and local secret template.

Still not implemented: Docker lifecycle management, automatic container IP assignment, public-IP verification, dashboard, provider-specific live validation, and production key rotation. See docs/STATUS.md before relying on this for workloads.

## Architecture boundary

Cloudflare is the authenticated WebSocket control/tunnel layer. The Oracle Linux gateway at 141.148.53.68 is the separate public ingress endpoint; its explicitly configured TCP/UDP listeners forward over the tunnel to one node identity at a time. Each node agent maintains its own authenticated tunnel and local service allowlists. Outbound node traffic takes the reverse path to the Oracle gateway, then uses that process's FineProxy SOCKS5 identity. FineProxy is not used for inbound port forwarding, and Cloudflare Workers/Containers are not treated as arbitrary public TCP/UDP listeners. No IP spoofing is used.

## Deploy the Worker

On a development machine with Node.js, clone this repository, then run:

   ~~~sh
   cd cloudflare
   npm install
   npx wrangler login
   npx wrangler secret put TUNNEL_TOKEN
   npx wrangler secret put CLIENT_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   npm run deploy
   ~~~

Use three independently generated random values. Never commit them. Wrangler prints the deployed Workers URL. The gateway role uses TUNNEL_TOKEN, the smoke-test client uses CLIENT_TOKEN, and the node listing uses ADMIN_TOKEN.

## Run the TCP proof

On the Oracle host, install the Python dependency:

   ~~~sh
   cd gateway
   python -m venv .venv
   . .venv/bin/activate
   pip install -r requirements.txt
   ~~~

For the existing loopback echo proof, set these values in the Oracle gateway shell:

   ~~~sh
   export TUNNEL_URL=wss://YOUR-WORKER.workers.dev/tunnel
   export TUNNEL_TOKEN='gateway-token-set-in-Cloudflare'
   export CLIENT_TOKEN='node-token-set-in-Cloudflare'
   export NODE_ID=oracle-gateway
   ~~~

Start three terminals on the Oracle host:

   ~~~sh
   cd gateway && python echo_server.py
   cd gateway && python client.py
   cd gateway && python tcp_smoke.py
   ~~~

The echo target binds only to 127.0.0.1:9000. The default `TCP_DIRECT_ALLOWLIST` is limited to this loopback fixture. Other allowed TCP destinations use FineProxy SOCKS5. Set `TCP_ALLOWLIST` and `UDP_DESTINATION_ALLOWLIST` to exact `host:port` values; set `TCP_DIRECT_ALLOWLIST=` explicitly in production to prevent direct egress. The smoke test opens two TCP streams and verifies echoes.

## UDP egress and public ingress

See [docs/NETWORKING.md](docs/NETWORKING.md) for per-node deployment configuration. FineProxy's SOCKS5 hostname, port, rotated username, and rotated password are runtime environment values on the Oracle gateway only. Do not put proxy credentials in GitHub, `.dev.vars`, or source files. Configure only the Oracle listener ports you intend to expose, open those same ports in the host/cloud firewall, and keep the node-side ingress allowlists exact.

Check GET /health on the deployed URL. To list active roles, send GET /v1/nodes with Authorization: Bearer <ADMIN_TOKEN>.

For local Worker development, copy cloudflare/.dev.vars.example to cloudflare/.dev.vars, set disposable local-only secrets, and run npm run dev. The Python clients must be able to reach Wrangler's local WebSocket endpoint.

## Replit and Cloudflare cost

This source repository and deployment flow do not require a Replit plan upgrade. Cloudflare has its own plan limits: as checked against the official docs on 2026-10-07, the Workers Free plan supports SQLite-backed Durable Objects with 100,000 DO requests/day and 13,000 GB-s/day; exceeding a free limit causes further operations of that type to fail. WebSocket message accounting and storage quotas also apply. Hibernation reduces idle duration charges, but heartbeats and traffic still consume quota. Check Cloudflare's current limits before production use. This starter does not use Cloudflare Containers, which are not included in the Workers Free plan.

## Commands

- cd cloudflare && npm run dev - local Worker development.
- cd cloudflare && npm run check - Wrangler dry-run bundle/config check.
- cd cloudflare && npm run deploy - deploy to the Cloudflare account logged into Wrangler.
- cd gateway && python -m unittest -v - run Python protocol and SOCKS5 tests.

See docs/STATUS.md, docs/NETWORKING.md, and protocol/frame-v1.md for scope, routing, and wire format.
