# Hybrid Stockroom architecture contract

Status: implementation baseline for the Vampirequid hybrid Stockroom rollout.

## Goals

- Run a dedicated Stockroom service and local SQLite working database inside each merchant's TinyCore environment.
- Keep Cloudflare authoritative for sellable inventory, reservations, committed orders, and synchronization acknowledgements.
- Keep the existing Cloudflare Durable Object fallback available until the TinyCore service is provisioned and verified for a merchant.
- Preserve merchant isolation and support safe offline POS activity using previously reserved offline allocations.

## Data ownership

| Data | Authority | Runtime copy |
| --- | --- | --- |
| Product details and catalog edits | Stockroom catalog, synchronized to Cloudflare | TinyCore SQLite |
| Sellable inventory and reservations | Per-merchant InventoryLedger Durable Object | TinyCore working copy |
| Online checkout and paid order state | Cloudflare payment/checkout flow and InventoryLedger | TinyCore receives order events |
| Offline POS allocations and accepted offline sales | InventoryLedger validates allocations and records accepted events | TinyCore records local sale/outbox event |
| Merchant database recovery | Encrypted/versioned backup in R2 plus restore procedure | TinyCore local database |

The catalog is not an independent inventory authority. Available quantity is calculated centrally as on-hand stock minus active online reservations and offline allocations.

## Request and synchronization flows

### Catalog updates

1. TinyCore writes product changes to its local SQLite database.
2. The sync agent sends a bounded catalog batch to the merchant's authenticated Cloudflare route.
3. Every new sync request includes a stable UUID event_id; retries reuse the same ID and identical payload.
4. Cloudflare records the event ID and payload SHA-256 in the same SQLite transaction as accepted catalog changes.
5. Replaying the same ID and payload returns a duplicate acknowledgement without reapplying the batch. Reusing an ID with different content returns HTTP 409.
6. Older product timestamps are ignored; stock reductions that would violate active reservations or offline allocations are rejected.

The event ID is optional only during the compatibility period for existing clients. New TinyCore clients must always supply it.

### Online checkout

1. Cloudflare reserves stock in the merchant's InventoryLedger.
2. Payment processing occurs through the existing merchant payment flow.
3. A successful payment commits the reservation and creates one durable pending-sync order.
4. TinyCore receives the order through an authenticated, retryable delivery path.
5. Cloudflare retains the order until the merchant service acknowledges it.

### Offline POS

1. While online, TinyCore obtains a bounded offline allocation from InventoryLedger.
2. While disconnected, it can sell only against the remaining quantity in that allocation.
3. Each local sale has a stable event UUID and order UUID.
4. On reconnect, the sale is submitted with the original IDs. Duplicate delivery must not deduct stock twice.
5. Allocation expiry and conflict/rejection states must be visible to the merchant; no event is silently discarded.

## Tenant and gateway security

- Resolve the merchant account from the authenticated session or scoped integration credential, never from an untrusted request body alone.
- Resolve the VM destination from trusted server-side merchant provisioning state. Do not accept arbitrary upstream URLs from merchants.
- Bind each Stockroom database and gateway identity to exactly one merchant account.
- Keep the Stockroom service private to the gateway; do not expose its management port publicly.
- Use per-merchant credentials or short-lived VM identity tickets. A platform-wide gateway secret is not tenant isolation.
- Redact credentials and payment references from logs. Do not place secrets in VM snapshots or repository files.

## Availability and recovery

- If TinyCore is offline, Cloudflare remains able to serve the storefront, reserve inventory, process online orders, and preserve authoritative records.
- TinyCore queues permitted offline POS events locally and retries with stable event IDs.
- R2 backups must be encrypted, versioned, and tested with actual restore drills.
- A VM is not marked ready until its service health check, database initialization, gateway identity, and initial catalog synchronization succeed.

## Rollout gates

1. Ledger idempotency and tenant-isolation tests pass.
2. TinyCore service survives process restart and VM reboot with its local data intact.
3. Gateway rejects invalid credentials and cross-tenant routing.
4. Offline allocation, duplicate replay, expiry, and conflict tests pass.
5. Order delivery and acknowledgement survive transient outages.
6. Backup restoration and full checkout/POS end-to-end tests pass.

Do not remove the Cloudflare fallback or route production merchants to TinyCore until the relevant merchant environment passes these gates.
