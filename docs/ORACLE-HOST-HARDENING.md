# Oracle origin and guest-network hardening

## Current tunnel topology

The Oracle gateway initiates an outbound `wss://` WebSocket connection to the Cloudflare Worker. It is not a `cloudflared` ingress tunnel and does not require an Oracle listener for Cloudflare to connect to. The gateway uses a bearer credential; the Worker validates it before proxying, and the TunnelHub Durable Object independently checks the same role credential. Do not expose SSH, a relay listener, Docker API, or guest administration ports to the Internet.

Authenticated Origin Pulls (mTLS) are not the correct control for this topology: there is no public Oracle HTTPS origin behind Cloudflare receiving inbound requests. The outbound WebSocket is authenticated by its bearer credential over TLS. Do not add an inbound listener just to use AOP. If a future design adds a public HTTP origin, use Cloudflare Authenticated Origin Pulls and strict host firewall rules for that origin.

## OCI Security Lists / NSGs

1. Remove broad IPv4 and IPv6 ingress rules such as TCP/22 from `0.0.0.0/0` or `::/0`, all-TCP, all-UDP, and broad ICMP rules. The outbound tunnel requires no new inbound rule.
2. If SSH administration is required, allow TCP/22 only from a fixed administrator IP/CIDR, preferably through OCI Bastion or a private management network.
3. Keep stateful egress for TCP/443 to Cloudflare and DNS to the configured resolver. Restrict other egress where practical.
4. Check every attached Security List and NSG; a permissive rule in any attached list can still allow traffic.
5. Verify externally that the public IP has no reachable service ports. Do not make destructive firewall changes over your only SSH session.

OCI Security Lists and NSGs are allow-lists: remove unwanted ingress allows rather than expecting a deny rule to override them.

## Host firewall

Run `gateway/oracle-host-firewall.sh` from the OCI serial console, or set `SSH_ALLOW_CIDR` and/or `SSH_ALLOW_CIDR6` to the administrator's fixed IPv4/IPv6 source CIDR. It inserts a dedicated INPUT chain without flushing unrelated rules. The policy accepts loopback and established return traffic, optionally permits SSH from explicitly configured IPv4/IPv6 administrator CIDRs, and drops all other new inbound connections. It installs equivalent IPv4 and IPv6 ingress chains when IPv6 is enabled. Validate a second SSH session before persisting with the host OS firewall manager.

The Oracle gateway's outbound WSS connection continues to work because replies are established traffic. Do not add inbound Cloudflare IP ranges for this outbound-only tunnel.

## Guest network isolation

The headless TinyCore path runs v86/WebAssembly in the Cloudflare Worker and uses an account-scoped WISP relay; it is not a set of QEMU/Firecracker guests attached to an Oracle Linux bridge. WISP now permits only public IPv4 TCP/80 and TCP/443 and rejects RFC1918, loopback, link-local (including `169.254.169.254`), CGNAT, documentation, benchmarking, multicast/reserved ranges, and Azure's `168.63.129.16` platform address. Account-specific Durable Objects isolate each account's WISP ticket/session. Tickets expire after two minutes and are single-use. Each account relay also caps new TCP connection attempts at 30 per minute and concurrent streams at 32.

`gateway/oracle-guest-egress.sh` is a fail-closed template for a future dedicated Linux guest bridge. It is deliberately not auto-applied: configure the actual bridge, guest CIDR, and gateway only after that network exists. It blocks guest-to-guest traffic, metadata, private host networks, and non-HTTP(S) egress. Do not attach merchant guests to the Oracle host network namespace.

## Cloudflare WAF and edge rate limiting

The proxied Vampirequid zone has the Cloudflare Managed Free Ruleset deployed. Two zone custom rules are active:
- Block common secret-file and unused CMS probes (`.env`, `.git`, WordPress login/XML-RPC, and phpMyAdmin paths).
- Block TRACE and CONNECT methods on `/api/*` routes.

A zone rate-limiting rule is active for guest network tickets, VM agent tickets/WebSockets, admin/account command execution, VM node creation/start, runtime diagnostics, and tunnel handshakes: five matching requests per 10 seconds per source IP, with a 10-second block. This is the single rate-limiting rule configured for the current Free Website plan. The Worker also has independent atomic per-IP limits: signup 5/hour, login 10/15 minutes, network tickets 12/15 minutes, WISP connects 60/15 minutes, VM agent tickets 20/15 minutes, VM agent connects 30/15 minutes, command execution 60/minute, VM provisioning 5/15 minutes, diagnostics 10/15 minutes, and tunnel connects 120/15 minutes.

Cloudflare WAF applies to proxied traffic. Keep the public hostname proxied, and re-check the zone's WAF entry-point rulesets after any zone migration or DNS change. The managed free ruleset is maintained by Cloudflare; do not replace it with a hand-maintained static signature list.

## Credential operations

- Keep `TUNNEL_TOKEN`, `CLIENT_TOKEN`, and `ADMIN_ACCESS_KEY` in Worker secrets, never in Git.
- Keep the gateway token in a root-owned mode-600 environment file. Rotate it in Cloudflare and the Oracle service together; a rotation without coordinated restart disconnects the gateway.
- Keep per-node credentials unique and rotate any token that may have been exposed.
- Never put tunnel credentials in URLs, logs, issue comments, or screenshots.

## Verification checklist

- Handshakes with no token, a wrong token, gateway token used as client, and client token used as gateway must fail.
- `/nodes` must reject requests without the admin credential.
- WISP connections to `10.0.0.1`, `127.0.0.1`, `169.254.169.254`, `168.63.129.16`, and `192.168.1.1` must be rejected.
- Reusing a WISP ticket must fail on the second WebSocket handshake.
- Repeated network-ticket, WISP connection, VM agent-ticket, and tunnel handshakes must hit rate limits.
- From outside OCI, scan only your own public IP and verify no inbound services are exposed.
- Confirm guest-to-guest and guest-to-metadata isolation only after a real guest bridge has been configured.
