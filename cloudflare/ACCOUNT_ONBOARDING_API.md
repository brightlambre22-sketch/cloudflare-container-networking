# Browserless account onboarding API (no Containers)

This branch deliberately does **not** configure Cloudflare Containers. It adds an account-provisioning path using the existing Worker, Durable Objects, and R2 snapshot store.

## What this proves

- A caller can create an account over HTTP without opening `/vm.html`.
- The Worker verifies a shared provisioning token.
- Each account receives a random ID and a one-time account API key.
- The account registry persists account metadata in a Durable Object.
- The Worker clones the configured baseline snapshot chunks from R2 into an account-specific R2 prefix.
- Account metadata is marked `ready` only after all chunks and the manifest are written.

This is the **onboarding and snapshot-isolation proof of concept**, not yet proof that Linux commands execute browserlessly. The Worker does not execute Linux, and the old `/v1/vm/exec` endpoint remains browser-agent based. No container is started by this account API.

## Configure the baseline

The configured baseline defaults to `v2` (override with `VM_BASELINE_ID`). R2 must contain a valid snapshot manifest and every chunk at:

- `vm-snapshots/v2/manifest.json`
- `vm-snapshots/v2/<generation>/<part>.bin`

The manifest format is the existing v86 snapshot format: `version: 1`, `generation`, `chunks`, `byteLength`, and `savedAt`. Chunks are 8 MiB each, and `chunks` must equal `ceil(byteLength / 8 MiB)`. The snapshot must have been produced by the compatible v86 version/options used by the VM.

Do not point the baseline at a live, changing account snapshot. Use a clean, known-good baseline. Provisioning copies the existing chunks; later per-account snapshots must continue to use the account's own identity.

## Configure the provisioning token

From `cloudflare/`:

```sh
npx wrangler secret put VM_API_TOKEN
npm run check
npm run deploy
```

Use a long random value for `VM_API_TOKEN`. Keep it server-side; do not place it in a public web page or client-side JavaScript.

## Create an account

```sh
curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/accounts' \
  -H 'Authorization: Bearer YOUR_VM_API_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Example account"}'
```

Successful creation returns HTTP `201`, the account ID, `status: "ready"`, the baseline ID, the per-account snapshot identity, and a newly generated `api_key`. **Save the account key securely; it is returned only once.** Account creation returns an error if the baseline manifest or any chunk is missing. No browser interaction is part of this request.

## Read account metadata

```sh
curl -sS 'https://YOUR-WORKER-DOMAIN/v1/accounts/acct-YOUR-ACCOUNT-UUID' \
  -H 'Authorization: Bearer acct_YOUR_64_HEX_CHARACTER_ACCOUNT_KEY'
```

The account key authorizes reading only that account's metadata. The provisioning token is required to create accounts.

## Response and current limitations

Account creation currently copies the entire snapshot, so R2 operation count and storage grow with each account. It does not start a VM or execute a shell command. The returned `runtime` field explicitly says that headless execution is not yet wired.

Next milestone: a no-container feasibility test for running the existing v86 snapshot in a Cloudflare Worker-compatible execution context. Workers/Durable Objects are not general-purpose Linux hosts; if the v86 runtime depends on unavailable browser APIs or exceeds CPU/memory limits, a separate execution backend will be required. Do not represent this onboarding PoC as full browserless VM execution until that test passes.

## Security note

The existing snapshot endpoints predate this account API. Review and restrict direct snapshot read/write access before production use; never expose another account's snapshot identity or account API key. Add rate limits, quotas, audit events, idempotency keys, and cleanup for interrupted provisioning before production.
