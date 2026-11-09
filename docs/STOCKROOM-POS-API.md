# Stockroom and POS API

All account-scoped routes use the merchant's `account_id` query parameter and a bearer credential:

```http
Authorization: Bearer <credential>
```

Use the shared merchant session token for first-party Vampirequid/TinyCore clients. External POS systems use the optional **POS integration key** generated in the merchant dashboard. Rotating that key immediately invalidates the previous key. Never put either credential in a URL.

## POS key permissions

The POS key is intentionally narrower than a merchant session. It can:
- Read the active product catalog and inventory movements.
- Allocate stock for an offline register session.
- Submit offline sales and release unused allocations.
- Trigger pending-order synchronization and read merchant order history.

It cannot create, edit, archive products, upload merchant media, or change account/payment settings. Those operations require the merchant's shared login session.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stockroom/products?account_id=<account_id>` | Read products and stock |
| GET | `/api/stockroom/movements?account_id=<account_id>` | Read recent inventory movements |
| POST | `/api/stockroom/offline-allowance?account_id=<account_id>` | Reserve inventory for offline POS |
| POST | `/api/stockroom/offline-allowance/release?account_id=<account_id>` | Return unused reserved inventory |
| POST | `/api/stockroom/offline-sales?account_id=<account_id>` | Submit an offline sale to the durable outbox |
| POST | `/api/stockroom/sync/orders?account_id=<account_id>` | Apply pending orders to TinyCore Stockroom |
| GET | `/api/stockroom/orders?account_id=<account_id>` | Read paid order history and attempt sync |

## Offline register workflow

1. Generate a UUID `allocation_id` and request an allowance before disconnecting.
2. Store the allocation response on the POS device. Allocations default to a 24-hour expiry (configurable from 60 seconds up to 7 days). The same `allocation_id` and same allocation body are idempotent; reusing it with different quantities returns a conflict. Expired allocations release their unused stock on the next ledger request.
3. While offline, persist each sale locally with a stable UUID `event_id` and `order_id`. Do not discard the local sale until the server acknowledges it.
4. When connectivity returns, submit each sale using the original IDs. Repeating the same event/order is safe; reusing an event ID for a different order is rejected.
5. Release the allocation when the register session ends. Unused quantities return to available stock. A fully consumed allocation closes automatically.
6. Call order sync (or read order history) so the outbox is applied to the merchant's TinyCore database. Order application is idempotent by `order_id`.

**Payment boundary:** `payment_method` and `payment_reference` are recorded as sale metadata. This API does not authorize or capture card or PayPal payments. A register must complete payment through its payment provider (or record cash/gift-card tender) before submitting the sale as completed.

### Allocate stock

```http
POST /api/stockroom/offline-allowance?account_id=acct-...
Authorization: Bearer <POS_KEY>
Content-Type: application/json

{
  "allocation_id": "b18e2e73-4e14-4c93-9c7b-bc50a9e8b2c1",
  "ttl_seconds": 86400,
  "allocations": [
    { "product_id": "4d0f4b7d-a7bc-4a42-92d1-aad9d0b7b6f1", "quantity": 8 }
  ]
}
```

### Submit an offline sale

```http
POST /api/stockroom/offline-sales?account_id=acct-...
Authorization: Bearer <POS_KEY>
Content-Type: application/json

{
  "allocation_id": "b18e2e73-4e14-4c93-9c7b-bc50a9e8b2c1",
  "event_id": "c2bdc29d-2f9b-4df7-8c9e-5ec2a1d6a1d0",
  "order_id": "5c65dce1-7f5b-4a68-a7d9-3b2bdb68d4df",
  "items": [
    { "product_id": "4d0f4b7d-a7bc-4a42-92d1-aad9d0b7b6f1", "quantity": 2 }
  ]
}
```

The server records the sale against the allocation, stores the payment method/reference for reconciliation, decrements both the allocation remainder and central available stock, and creates a `pending_sync` order in the durable outbox. Supported payment methods are `offline_pos` (default), `cash`, `card`, `paypal`, `gift_card`, and `other`.

### Release unused stock

```http
POST /api/stockroom/offline-allowance/release?account_id=acct-...
Authorization: Bearer <POS_KEY>
Content-Type: application/json

{ "allocation_id": "b18e2e73-4e14-4c93-9c7b-bc50a9e8b2c1" }
```

## Product management (merchant session)

The same `/api/stockroom/products` route supports:
- `POST` create a product.
- `PUT /api/stockroom/products/<product_id>` update a product.
- `DELETE /api/stockroom/products/<product_id>` archive a product.

Product images are uploaded with `POST /api/stockroom/media/<product_id>?account_id=...` as multipart form data using the `image` field. Supported formats are JPEG, PNG, WebP, and GIF, up to 5 MB. Images are stored under the merchant's R2 prefix.

## Error behavior

- `401 unauthorized`: invalid, expired, or wrong-account credential.
- `403 pos_key_scope_forbidden`: a POS key attempted a merchant-only operation.
- `409 insufficient_unallocated_stock` / `offline_allowance_exceeded`: requested stock is not available within the allocation.
- `409 offline_allocation_id_conflict`: an allocation ID was reused with a different allocation body.
- `409 offline_event_id_conflict`: an event ID was reused for a different order.
- `503 tinycore_stockroom_unavailable` or sync errors: retain the local queue and retry; do not mark the order synchronized until acknowledged.

POS catalog responses omit merchant cost fields. The POS key is intended for server-side or trusted local POS software; do not embed it in a public browser application. The POS client should use HTTPS, store credentials in a secure secret store, keep a durable local sales queue, and retry with the same event and order IDs.
