// Ticket 031 FR-5 / NFR-1: parse a Razorpay webhook and keep only an allowlisted copy for `payment_events.payload`.
// Card, VPA (UPI id), bank, wallet, email, phone, notes, acquirer data, descriptions and anything not listed below are
// dropped before anything is stored or logged. Pure (no I/O).

export const HANDLED_EVENTS = ["payment.authorized", "payment.captured", "payment.failed", "refund.processed"] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

const PAYMENT_KEYS = ["id", "entity", "order_id", "status", "amount", "currency", "method", "captured", "refund_status", "amount_refunded", "error_code", "error_reason", "error_source", "error_step", "created_at"] as const;
const REFUND_KEYS = ["id", "entity", "payment_id", "amount", "currency", "status", "speed_processed", "created_at"] as const;
const ORDER_KEYS = ["id", "entity", "amount", "amount_paid", "currency", "status", "attempts", "created_at"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 120);
  return undefined;
}

function pick(entity: unknown, keys: readonly string[]): Json | undefined {
  if (!isObject(entity)) return undefined;
  const out: Json = {};
  for (const key of keys) {
    const value = scalar(entity[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function entityOf(payload: unknown, name: string): unknown {
  return isObject(payload) && isObject(payload[name]) ? (payload[name] as Json).entity : undefined;
}

export type ParsedWebhook = {
  event: string;
  payment?: { id: string; order_id: string | null; amount: number | null; status: string | null; error: string | null };
  refund?: { id: string; payment_id: string; status: string | null };
  /** Allowlisted copy for payment_events.payload. */
  stored: Json;
};

/** Throws on a body that is not a Razorpay event object. */
export function parseWebhook(rawBody: string): ParsedWebhook {
  const body = JSON.parse(rawBody) as unknown;
  if (!isObject(body) || typeof body.event !== "string" || !body.event) throw new Error("not a Razorpay event");
  const payment = pick(entityOf(body.payload, "payment"), PAYMENT_KEYS);
  const refund = pick(entityOf(body.payload, "refund"), REFUND_KEYS);
  const order = pick(entityOf(body.payload, "order"), ORDER_KEYS);
  const stored: Json = {
    event: body.event.slice(0, 80),
    ...(typeof body.created_at === "number" ? { created_at: body.created_at } : {}),
    ...(payment ? { payment } : {}),
    ...(refund ? { refund } : {}),
    ...(order ? { order } : {}),
  };
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const error = [str(payment?.error_code), str(payment?.error_reason)].filter(Boolean).join(": ") || null;
  return {
    event: body.event,
    ...(payment && str(payment.id)
      ? {
          payment: {
            id: payment.id as string,
            order_id: str(payment.order_id),
            amount: typeof payment.amount === "number" ? payment.amount : null,
            status: str(payment.status),
            error,
          },
        }
      : {}),
    ...(refund && str(refund.id) && str(refund.payment_id)
      ? { refund: { id: refund.id as string, payment_id: refund.payment_id as string, status: str(refund.status) } }
      : {}),
    stored,
  };
}

export function isHandledEvent(event: string): event is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(event);
}
