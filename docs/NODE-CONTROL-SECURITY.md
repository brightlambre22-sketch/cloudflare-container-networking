# Node control-plane security

## Route authorization

The Worker now separates privileged operator actions from TinyCore runner liveness:

- `GET/POST /v1/nodes`, `GET /v1/nodes/{id}`, and runtime start/stop/probe require the existing authenticated admin session or admin key.
- Runtime status polling, heartbeat, and runner status PATCH require the dedicated `NODE_CONTROL_TOKEN` bearer credential.
- If `NODE_CONTROL_TOKEN` is not configured, runner routes fail closed with HTTP 503. An absent credential is never treated as an open development mode.
- The TinyCore runner sends the credential on every control-plane request and refuses to start when it is absent.

## Required deployment configuration

Before enabling the runner, provision a high-entropy random value as the Worker secret named `NODE_CONTROL_TOKEN` and inject the corresponding value into the per-node `/etc/cloudflare-node/node.env` file with permissions `0600`. Never put a real token in Git, an ISO, a URL, command-line arguments, logs, or merchant-visible browser code. Do not reuse `TUNNEL_TOKEN`, `CLIENT_TOKEN`, or `ADMIN_ACCESS_KEY`.

This change deliberately does not create or rotate production secrets and does not modify Cloudflare bindings.

## Remaining security work

The current credential is a platform-wide runner credential. It is an interim control, not the final per-merchant identity design. Before production:

1. Replace the shared runner credential with short-lived, per-node credentials bound to a specific node ID and role.
2. Make runner PATCH accept only liveness/status fields and validate state transitions; never allow a runner to modify its node identity, private address, ownership, or runtime class.
3. Add rate limits, replay-resistant signed requests, rotation/revocation, and security audit events.
4. Verify the runner cannot reach another merchant's VM, data, or console.
5. Add integration tests against the deployed Worker and a real TinyCore guest.

## Acceptance checks

- Unauthenticated node list/create/read/update/start/stop/probe requests return 401.
- A valid admin session can perform operator-only operations.
- Missing runner secret returns 503.
- Invalid runner secret returns 401.
- A valid runner credential can read its assigned runtime state and send heartbeat.
- A runner cannot list or create nodes, nor invoke start/stop/probe.
- Cross-node isolation and credential revocation are verified in an integration environment.

A passing source-contract test is not proof that these runtime acceptance checks have passed.
