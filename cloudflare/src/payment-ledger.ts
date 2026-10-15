import { DurableObject } from "cloudflare:workers";

type PaymentStatus = "requires_confirmation" | "succeeded" | "refunded";

interface PaymentEvent {
  type: "created" | "confirmed" | "refunded";
  at: string;
}

interface PaymentRecord {
  id: string;
  merchant_id: string;
  amount_cents: number;
  currency: "usd";
  description: string | null;
  status: PaymentStatus;
  simulated: true;
  money_moved: false;
  created_at: string;
  updated_at: string;
  events: PaymentEvent[];
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function validMerchantId(value: string | null): value is string {
  return !!value && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export class PaymentLedger extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const merchantId = request.headers.get("x-merchant-id");

    if (!validMerchantId(merchantId)) {
      return json({ error: "invalid_or_missing_merchant_id" }, 400);
    }

    if (url.pathname === "/payments" && request.method === "POST") {
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > 16_384) return json({ error: "body_too_large" }, 413);

      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        return json({ error: "valid_idempotency_key_required" }, 400);
      }

      let body: { amount_cents?: unknown; currency?: unknown; description?: unknown };
      try {
        const raw = await request.text();
        if (raw.length > 16_384) return json({ error: "body_too_large" }, 413);
        body = JSON.parse(raw) as typeof body;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      if (!Number.isSafeInteger(body.amount_cents) ||
          (body.amount_cents as number) < 50 ||
          (body.amount_cents as number) > 10_000_000) {
        return json({ error: "invalid_amount_cents", minimum: 50, maximum: 10_000_000 }, 400);
      }
      if (body.currency !== undefined && body.currency !== "usd") {
        return json({ error: "unsupported_currency", supported: ["usd"] }, 400);
      }
      if (body.description !== undefined &&
          (typeof body.description !== "string" || body.description.length > 200)) {
        return json({ error: "invalid_description" }, 400);
      }

      const key = `idempotency:${merchantId}:${idempotencyKey}`;
      const result = await this.ctx.storage.transaction(async (txn) => {
        const priorId = await txn.get<string>(key);
        if (priorId) {
          const prior = await txn.get<PaymentRecord>(`payment:${priorId}`);
          if (prior) return { payment: prior, replayed: true };
        }

        const now = new Date().toISOString();
        const payment: PaymentRecord = {
          id: `pay_${crypto.randomUUID()}`,
          merchant_id: merchantId,
          amount_cents: body.amount_cents as number,
          currency: "usd",
          description: typeof body.description === "string" ? body.description : null,
          status: "requires_confirmation",
          simulated: true,
          money_moved: false,
          created_at: now,
          updated_at: now,
          events: [{ type: "created", at: now }],
        };
        await txn.put(key, payment.id);
        await txn.put(`payment:${payment.id}`, payment);
        return { payment, replayed: false };
      });

      return json({
        ...result.payment,
        idempotent_replay: result.replayed,
        notice: "SIMULATION ONLY — no payment was processed and no money moved.",
      }, result.replayed ? 200 : 201);
    }

    const match = url.pathname.match(/^\/payments\/(pay_[a-f0-9-]+)(?:\/(confirm|refund))?$/i);
    if (!match) return json({ error: "not_found" }, 404);

    const paymentId = match[1];
    const action = match[2];

    if (!action && request.method === "GET") {
      const payment = await this.ctx.storage.get<PaymentRecord>(`payment:${paymentId}`);
      if (!payment || payment.merchant_id !== merchantId) return json({ error: "payment_not_found" }, 404);
      return json({
        ...payment,
        notice: "SIMULATION ONLY — this record does not represent a real payment.",
      });
    }

    if ((action === "confirm" || action === "refund") && request.method === "POST") {
      const result = await this.ctx.storage.transaction(async (txn) => {
        const key = `payment:${paymentId}`;
        const payment = await txn.get<PaymentRecord>(key);
        if (!payment || payment.merchant_id !== merchantId) {
          return { error: "payment_not_found" as const };
        }

        if (action === "confirm") {
          if (payment.status === "succeeded") return { payment, unchanged: true };
          if (payment.status !== "requires_confirmation") {
            return { error: "payment_not_confirmable" as const, status: payment.status };
          }
          const now = new Date().toISOString();
          const updated: PaymentRecord = {
            ...payment,
            status: "succeeded",
            updated_at: now,
            events: [...payment.events, { type: "confirmed", at: now }],
          };
          await txn.put(key, updated);
          return { payment: updated, unchanged: false };
        }

        if (payment.status === "refunded") return { payment, unchanged: true };
        if (payment.status !== "succeeded") {
          return { error: "payment_not_refundable" as const, status: payment.status };
        }
        const now = new Date().toISOString();
        const updated: PaymentRecord = {
          ...payment,
          status: "refunded",
          updated_at: now,
          events: [...payment.events, { type: "refunded", at: now }],
        };
        await txn.put(key, updated);
        return { payment: updated, unchanged: false };
      });

      if ("error" in result) {
        if (result.error === "payment_not_found") return json({ error: result.error }, 404);
        return json({ error: result.error, status: result.status }, 409);
      }
      return json({
        ...result.payment,
        idempotent_replay: result.unchanged,
        notice: "SIMULATION ONLY — no payment or refund was processed and no money moved.",
      });
    }

    return json({ error: "method_not_allowed" }, 405);
  }
}
