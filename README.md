# Cloudflare Container Networking

A Cloudflare-first control and tunnel foundation for the larger networking design. The initial milestone proves an authenticated, persistent WebSocket from the Oracle gateway to a Durable Object and automatic reconnects. It is intentionally not presented as a finished TCP/UDP VPN or container platform.

## First slice

- Worker routes for health, authenticated gateway WebSocket, and authenticated live-node listing.
- Hibernatable Durable Object WebSocket endpoint with application-level PING/PONG and live connection metadata.
- Python gateway client with TLS WebSocket, structured logs, heartbeat, and exponential reconnect with jitter.
- Cloudflare SQLite-backed Durable Object configuration compatible with Workers Free.

Not implemented yet: TCP stream forwarding, UDP datagram transport, multiplexed data frames, Docker lifecycle management, container IP assignment, proxy adapters, egress enforcement, public-IP verification, ingress, dashboard, and production key rotation. See docs/STATUS.md before relying on this for workloads.

## Architecture boundary

Cloudflare is the HTTP/WebSocket control and tunnel layer. The gateway at 141.148.53.68 is a separate Linux host and remains responsible for Docker, raw networking, and any eventual TCP/UDP bridge. Workers accept HTTP and WebSockets; Workers can open outbound TCP sockets, but Cloudflare documents inbound direct TCP as not yet supported. Do not assume an HTTP/WebSocket endpoint can accept arbitrary public UDP. No IP spoofing is used.

## Fast start

1. Install Node.js and Python 3.10+ on a development machine, clone this repository, then run:

   ~~~sh
   cd cloudflare
   npm install
   npx wrangler login
   npx wrangler secret put TUNNEL_TOKEN
   npx wrangler secret put ADMIN_TOKEN
   npm run deploy
   ~~~

   Use two independently generated random values for the secrets. Never commit them. Wrangler prints the deployed Workers URL.

2. On the Oracle gateway, install the Python dependency and start the client (substitute the deployed workers.dev or custom-domain URL):

   ~~~sh
   cd gateway
   python -m venv .venv
   . .venv/bin/activate
   pip install -r requirements.txt
   export TUNNEL_URL=wss://YOUR-WORKER.workers.dev/tunnel
   export TUNNEL_TOKEN='the-same-TUNNEL_TOKEN-set-in-Cloudflare'
   export NODE_ID=oracle-gateway
   python client.py
   ~~~

   The gateway only opens outbound TLS/WebSocket traffic to Cloudflare; this milestone does not require opening an inbound port on Oracle. Keep the token in an environment/secret manager, not shell history or a checked-in file.

3. Check GET /health on the deployed URL. To list live tunnel sessions, send GET /v1/nodes with Authorization: Bearer <ADMIN_TOKEN>.

For local Worker development, copy cloudflare/.dev.vars.example to cloudflare/.dev.vars, fill in disposable local-only secrets, and run npm run dev. The gateway can connect to the local Wrangler WebSocket endpoint if the machine running it can reach that endpoint.

## Replit and Cloudflare cost

This source repository and deployment flow do not require a Replit plan upgrade. Cloudflare has its own plan limits: as checked against the official docs on 2026-10-07, the Workers Free plan supports SQLite-backed Durable Objects with 100,000 DO requests/day and 13,000 GB-s/day; exceeding a free limit causes further operations of that type to fail. WebSocket message accounting and storage quotas also apply. Hibernation reduces idle duration charges, but heartbeats and traffic still consume quota. Check Cloudflare's current limits before production use. This starter does not use Cloudflare Containers, which are not included in the Workers Free plan.

## Commands

- cd cloudflare && npm run dev - local Worker development.
- cd cloudflare && npm run check - Wrangler dry-run bundle/config check.
- cd cloudflare && npm run deploy - deploy to the Cloudflare account logged into Wrangler.
- cd gateway && python client.py - connect the gateway client after setting its environment variables.

See docs/STATUS.md for scope, known limits, and the next build stage.
