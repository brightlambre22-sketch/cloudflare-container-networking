# USD Payment PoC (simulation only)

This prototype demonstrates a small payment API with durable records, merchant-scoped idempotency, and create/confirm/refund state transitions. **It does not connect to a processor, authorize cards, transfer funds, or process real payments.** A `succeeded` status is simulated only.

## Configure the PoC token

Set a long, random secret in the Cloudflare Worker environment:

```sh
npx wrangler secret put PAYMENT_POC_TOKEN
```

The API fails closed with HTTP 503 until this secret is configured. Send it as a Bearer token. Do not put production payment credentials or card data in this PoC.

## Create a simulated payment

```sh
curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/poc/payments' \
  -H 'Authorization: Bearer YOUR_POC_TOKEN' \
  -H 'X-Merchant-Id: demo-shop' \
  -H 'Idempotency-Key: order-2026-0001' \
  -H 'Content-Type: application/json' \
  -d '{"amount_cents":2500,"currency":"usd","description":"Demo order"}'
```

The response includes a `pay_...` ID and `requires_confirmation` status. Repeating the request with the same merchant and idempotency key returns the same payment record.

## Confirm, retrieve, and refund

Use the returned payment ID in place of `pay_ID`:

```sh
curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/poc/payments/pay_ID/confirm' \
  -H 'Authorization: Bearer YOUR_POC_TOKEN' \
  -H 'X-Merchant-Id: demo-shop'

curl -sS 'https://YOUR-WORKER-DOMAIN/v1/poc/payments/pay_ID' \
  -H 'Authorization: Bearer YOUR_POC_TOKEN' \
  -H 'X-Merchant-Id: demo-shop'

curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/poc/payments/pay_ID/refund' \
  -H 'Authorization: Bearer YOUR_POC_TOKEN' \
  -H 'X-Merchant-Id: demo-shop'
```

Confirmation and refund are simulated state transitions. No money moves.

## Scope and limitations

- USD only; amounts are integer cents (50 cents through $100,000 for this PoC).
- Durable Object SQLite-backed storage keeps the PoC records between requests.
- One global Durable Object serializes this prototype's records; it is not a production scaling design.
- The Bearer token is a single shared PoC gate, not a merchant identity system. Merchant IDs are namespaces, not independently authenticated accounts.
- No card data, processor integration, hosted checkout, settlement, disputes, partial refunds, or real financial ledger is implemented.
- Before any live-money use, replace the shared-token model with proper merchant authentication/authorization, integrate an approved processor/acquirer, implement webhook signature verification and reconciliation, and complete legal/compliance/security review.
