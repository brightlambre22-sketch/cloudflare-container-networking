# Project status: tunnel health milestone

## Implemented in this commit

- Private GitHub repository with a Wrangler Worker and SQLite-backed Durable Object configuration.
- Public GET /health response.
- Bearer-protected GET /v1/nodes showing live WebSocket sessions.
- Bearer-protected /tunnel WebSocket endpoint with validated node IDs.
- Durable Object WebSocket Hibernation API for live sessions, bounded text control messages, PING/PONG, and last-seen timestamps.
- Python client for the Oracle gateway with TLS WebSocket, protocol pings, structured logs, and exponential reconnect with jitter.
- Deployment and secret setup notes. Oracle gateway public IP supplied for this project: 141.148.53.68.

## Explicitly not implemented

This is a deployable connection/health check, not packet transport. It does not carry application TCP streams or UDP datagrams; it does not multiplex streams; it does not manage Docker, private container addresses, proxies, egress policy, ingress, or public-IP verification. No container can yet use this tunnel to reach arbitrary destinations. Do not put production workloads behind this milestone.

Cloudflare documents HTTP and WebSocket ingress, outbound TCP sockets, and inbound direct TCP as not yet supported. This project does not claim arbitrary UDP support on Workers. The independent Linux gateway is mandatory for raw socket and container duties. Do not add IP spoofing, open remote Docker, or unrestricted shell commands.

## Next milestones

1. Add a versioned bounded binary framing protocol and codec tests (HELLO, AUTH_OK, OPEN/CLOSE, DATA, PING/PONG, ERROR, and flow control).
2. Implement gateway-side TCP stream handling and prove one bidirectional TCP flow through the persistent tunnel; add backpressure and stream timeouts.
3. Add UDP association/session handling only through a verified UDP-capable gateway/proxy path; preserve datagram boundaries and document Cloudflare ingress limits.
4. Add container isolation, per-node egress enforcement, proxy adapters, and public-IP verification on Oracle Linux.
5. Add signed component authentication, nonce replay protection/key rotation, management API, metrics, and operations tests before production use.

## Plan constraint

The starter uses a SQLite-backed Durable Object supported by Cloudflare Workers Free, and does not use Cloudflare Containers. Cloudflare Free has finite daily quotas; at the time checked, Durable Objects had 100,000 requests/day and 13,000 GB-s/day, with further operations failing after a limit is exceeded. Persistent WebSocket traffic has message accounting. Confirm current Cloudflare limits before running sustained tunnels; a Replit plan upgrade is not needed to deploy this repository.
