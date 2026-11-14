// Ticket 031: Razorpay client (test mode only, D-1), the demo gateway (DEMO_MODE) and signature checks.
// No SDK: Orders + Refunds (+ 045 Payment Links, 046 Route transfers / reversals) over HTTPS with basic auth. Server-only (node:crypto, secrets).
//   * Checkout signature (FR-4): HMAC_SHA256(order_id + "|" + payment_id, key_secret), hex.
//   * Payment link redirect signature (045): HMAC_SHA256(link_id|reference_id|status|payment_id, key_secret), hex.
//   * Webhook signature (FR-5): HMAC_SHA256(raw request body, webhook_secret), hex, header X-Razorpay-Signature.
// Both are compared in constant time (timingSafeEqual).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const TEST_KEY_PREFIX = "rzp_test_";
/** Shown to the browser in DEMO_MODE (the demo checkout never contacts Razorpay). */
export const DEMO_KEY_ID = "rzp_test_DEMOMODE";
export const RAZORPAY_API = "https://api.razorpay.com/v1";
export const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

export class RazorpayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayConfigError";
  }
}

export class RazorpayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** 429 / 5xx / network: worth retrying. */
    readonly retryable: boolean,
  ) {
    super(`razorpay ${status} ${code}`);
    this.name = "RazorpayApiError";
  }
}

/** D-1: only test keys. Throws for live (`rzp_live_`) or any other key id. */
export function assertTestKey(keyId: string | undefined): void {
  if (keyId !== undefined && !keyId.startsWith(TEST_KEY_PREFIX)) {
    throw new RazorpayConfigError("Razorpay live keys are not allowed: RAZORPAY_KEY_ID must start with rzp_test_ (test mode only).");
  }
}

// ---------- signatures ----------

export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Constant-time string comparison (length is not secret: both sides are 64 hex characters). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function checkoutSignature(orderId: string, paymentId: string, keySecret: string): string {
  return hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
}

export function verifyCheckoutSignature(
  input: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!keySecret || !input.signature) return false;
  return safeEqual(checkoutSignature(input.orderId, input.paymentId, keySecret), input.signature.trim().toLowerCase());
}

/** 045: the signature Razorpay adds to a payment link's callback redirect. */
export function paymentLinkSignature(
  input: { linkId: string; referenceId: string; status: string; paymentId: string },
  keySecret: string,
): string {
  return hmacSha256Hex(keySecret, `${input.linkId}|${input.referenceId}|${input.status}|${input.paymentId}`);
}

export function verifyPaymentLinkSignature(
  input: { linkId: string; referenceId: string; status: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!keySecret || !input.signature) return false;
  return safeEqual(paymentLinkSignature(input, keySecret), input.signature.trim().toLowerCase());
}

export function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string | null | undefined): boolean {
  if (!secret || !signature) return false;
  return safeEqual(hmacSha256Hex(secret, rawBody), signature.trim().toLowerCase());
}

// ---------- configuration ----------

export type RazorpaySettings = {
  mode: "demo" | "razorpay";
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
};

/** Server-only secret for the demo gateway, derived from the service role key (no constant in the code). */
function demoSecret(purpose: string): string {
  return createHash("sha256").update(`dnm-demo-razorpay:${purpose}:${env.SUPABASE_SERVICE_ROLE_KEY}`).digest("hex");
}

/**
 * The active configuration. Throws RazorpayConfigError for a non-test key id (always, also in DEMO_MODE) and, outside
 * DEMO_MODE, when the keys are missing. DEMO_MODE uses the demo gateway even when test keys are set.
 */
export function razorpaySettings(): RazorpaySettings {
  const keyId = env.RAZORPAY_KEY_ID;
  assertTestKey(keyId);
  if (env.DEMO_MODE) {
    return {
      mode: "demo",
      keyId: DEMO_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET ?? demoSecret("key"),
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? demoSecret("webhook"),
    };
  }
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new RazorpayConfigError("Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).");
  return { mode: "razorpay", keyId, keySecret, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? null };
}

// ---------- gateway ----------

export type GatewayOrder = { id: string; amount: number; currency: "INR"; receipt: string; status: string };
export type GatewayRefund = { id: string; payment_id: string; amount: number; status: "pending" | "processed" | "failed"; receipt?: string | null };
/** 045: a Razorpay payment link (`short_url` is the only thing shown to people: no child data, NFR-3). */
export type GatewayPaymentLink = { id: string; short_url: string; amount: number; status: string; reference_id: string };
export type PaymentLinkInput = {
  amountPaise: number;
  /** Unique per link (<= 40 characters). */
  referenceId: string;
  /** Shown on Razorpay's page: what is being paid for, never the child's name. */
  description: string;
  expireBy: Date;
  callbackUrl: string;
  notes: Record<string, string>;
};

/** 046: a Razorpay Route transfer from a captured payment to a linked account. */
export type GatewayTransfer = {
  id: string;
  /** Razorpay: created / pending / processed / failed / reversed / partially_reversed. */
  status: string;
  amount: number;
  recipient: string;
  on_hold: boolean;
  /** Our idempotency key (notes.payout_transfer) when Razorpay returns the notes. */
  payout_transfer: string | null;
};
export type GatewayReversal = { id: string; transfer_id: string; amount: number };
export type TransferInput = {
  paymentId: string;
  account: string;
  amountPaise: number;
  onHold: boolean;
  /** notes.payout_transfer = our payout_transfers.id: the idempotency key (looked up before creating). */
  idempotencyKey: string;
  notes: Record<string, string>;
};

export interface PaymentGateway {
  readonly kind: "razorpay" | "demo";
  readonly keyId: string;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  /** Full refund of a captured payment. */
  createRefund(paymentId: string, input: { amountPaise: number; receipt: string }): Promise<GatewayRefund>;
  listRefunds(paymentId: string): Promise<GatewayRefund[]>;
  fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
  /** 045: partial refunds (package unused sessions, session charges). */
  createPartialRefund?(paymentId: string, input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayRefund>;
  createPaymentLink?(input: PaymentLinkInput): Promise<GatewayPaymentLink>;
  /** Resolves "cancelled"; "paid" when the link was paid meanwhile (Razorpay refuses to cancel it). */
  cancelPaymentLink?(linkId: string): Promise<"cancelled" | "paid">;
  /** 046 Route: POST /payments/:id/transfers (one transfer). */
  createTransfer?(input: TransferInput): Promise<GatewayTransfer>;
  /** 046 Route: GET /payments/:id/transfers (idempotency look-up). */
  listTransfers?(paymentId: string): Promise<GatewayTransfer[]>;
  /** 046 Route: PATCH /transfers/:id { on_hold: false }. */
  releaseTransfer?(transferId: string): Promise<GatewayTransfer>;
  /** 046 Route: POST /transfers/:id/reversals. */
  createReversal?(transferId: string, input: { amountPaise: number; notes: Record<string, string> }): Promise<GatewayReversal>;
  /** 046 Route: GET /transfers/:id/reversals. */
  listReversals?(transferId: string): Promise<GatewayReversal[]>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function refundOf(json: Record<string, unknown>): GatewayRefund {
  const status = json.status === "processed" || json.status === "failed" ? json.status : "pending";
  return {
    id: String(json.id),
    payment_id: String(json.payment_id),
    amount: Number(json.amount),
    status,
    receipt: typeof json.receipt === "string" ? json.receipt : null,
  };
}

function linkOf(json: Record<string, unknown>): GatewayPaymentLink {
  return {
    id: String(json.id),
    short_url: String(json.short_url),
    amount: Number(json.amount),
    status: String(json.status),
    reference_id: String(json.reference_id ?? ""),
  };
}

function transferOf(json: Record<string, unknown>): GatewayTransfer {
  const notes = (json.notes && typeof json.notes === "object" ? json.notes : {}) as Record<string, unknown>;
  return {
    id: String(json.id),
    status: String(json.status ?? "pending"),
    amount: Number(json.amount),
    recipient: String(json.recipient ?? ""),
    on_hold: json.on_hold === true || json.on_hold === 1,
    payout_transfer: typeof notes.payout_transfer === "string" ? notes.payout_transfer : null,
  };
}

function reversalOf(json: Record<string, unknown>): GatewayReversal {
  return { id: String(json.id), transfer_id: String(json.transfer_id ?? ""), amount: Number(json.amount) };
}

/** Real Razorpay (test mode). Refuses to be created with a non-test key id (D-1). */
export function createRazorpayClient(opts: { keyId: string; keySecret: string; fetchImpl?: FetchLike; baseUrl?: string }): PaymentGateway {
  if (!opts.keyId) throw new RazorpayConfigError("RAZORPAY_KEY_ID is missing.");
  assertTestKey(opts.keyId);
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl ?? RAZORPAY_API;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64")}`;

  async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RazorpayApiError(0, "network_error", true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String((json.error as { code?: unknown } | undefined)?.code ?? "error").slice(0, 60);
      throw new RazorpayApiError(res.status, code, res.status === 429 || res.status >= 500);
    }
    return json;
  }

  return {
    kind: "razorpay",
    keyId: opts.keyId,
    async createOrder({ amountPaise, receipt, notes }) {
      const json = await call("POST", "/orders", { amount: amountPaise, currency: "INR", receipt, notes });
      return { id: String(json.id), amount: Number(json.amount), currency: "INR", receipt: String(json.receipt), status: String(json.status) };
    },
    async createRefund(paymentId, { amountPaise, receipt }) {
      return refundOf(await call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, speed: "normal", receipt }));
    },
    async listRefunds(paymentId) {
      const json = await call("GET", `/payments/${encodeURIComponent(paymentId)}/refunds`);
      return Array.isArray(json.items) ? (json.items as Record<string, unknown>[]).map(refundOf) : [];
    },
    async fetchRefund(paymentId, refundId) {
      return refundOf(await call("GET", `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`));
    },
    async createPartialRefund(paymentId, { amountPaise, receipt, notes }) {
      return refundOf(await call("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, speed: "normal", receipt, notes }));
    },
    async createPaymentLink(input) {
      const json = await call("POST", "/payment_links", {
        amount: input.amountPaise,
        currency: "INR",
        accept_partial: false,
        reference_id: input.referenceId,
        description: input.description,
        expire_by: Math.floor(input.expireBy.getTime() / 1000),
        // DoctorNearMe sends the link itself (in-app, WhatsApp template, QR at the desk); no customer details.
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: input.notes,
        callback_url: input.callbackUrl,
        callback_method: "get",
      });
      return linkOf(json);
    },
    async cancelPaymentLink(linkId) {
      try {
        await call("POST", `/payment_links/${encodeURIComponent(linkId)}/cancel`);
        return "cancelled";
      } catch (err) {
        if (err instanceof RazorpayApiError && err.status === 400) {
          const link = linkOf(await call("GET", `/payment_links/${encodeURIComponent(linkId)}`));
          if (link.status === "paid") return "paid";
          if (link.status === "cancelled" || link.status === "expired") return "cancelled";
        }
        throw err;
      }
    },
    async createTransfer(input) {
      const json = await call("POST", `/payments/${encodeURIComponent(input.paymentId)}/transfers`, {
        transfers: [
          {
            account: input.account,
            amount: input.amountPaise,
            currency: "INR",
            notes: { ...input.notes, payout_transfer: input.idempotencyKey },
            linked_account_notes: ["payout_item"],
            on_hold: input.onHold,
          },
        ],
      });
      const items = Array.isArray(json.items) ? (json.items as Record<string, unknown>[]) : [];
      if (!items[0]) throw new RazorpayApiError(502, "no_transfer_returned", true);
      return transferOf(items[0]);
    },
    async listTransfers(paymentId) {
      const json = await call("GET", `/payments/${encodeURIComponent(paymentId)}/transfers`);
      return Array.isArray(json.items) ? (json.items as Record<string, unknown>[]).map(transferOf) : [];
    },
    async releaseTransfer(transferId) {
      return transferOf(await call("PATCH", `/transfers/${encodeURIComponent(transferId)}`, { on_hold: false }));
    },
    async createReversal(transferId, { amountPaise, notes }) {
      return reversalOf(await call("POST", `/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountPaise, notes }));
    },
    async listReversals(transferId) {
      const json = await call("GET", `/transfers/${encodeURIComponent(transferId)}/reversals`);
      return Array.isArray(json.items) ? (json.items as Record<string, unknown>[]).map(reversalOf) : [];
    },
  };
}

/** Deterministic Razorpay-shaped id (`order_DEMO…`, `pay_DEMO…`, `rfnd_DEMO…`, `plink_DEMO…`) from a seed. */
export function demoId(prefix: "order" | "pay" | "rfnd" | "plink" | "trf" | "rvrsl" | "acc", seed: string): string {
  return `${prefix}_DEMO${createHash("sha256").update(`${prefix}:${seed}`).digest("hex").slice(0, 14)}`;
}

/** DEMO_MODE payment link page (our own: /pay/demo/<link id>, simulates Razorpay's hosted page). */
export function demoLinkUrl(linkId: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/pay/demo/${linkId}`;
}

/** DEMO_MODE gateway: no network, deterministic ids, refunds processed at once. */
export function createDemoGateway(): PaymentGateway {
  return {
    kind: "demo",
    keyId: DEMO_KEY_ID,
    async createOrder({ amountPaise, receipt }) {
      return { id: demoId("order", receipt), amount: amountPaise, currency: "INR", receipt, status: "created" };
    },
    async createRefund(paymentId, { amountPaise }) {
      return { id: demoId("rfnd", paymentId), payment_id: paymentId, amount: amountPaise, status: "processed" };
    },
    async listRefunds() {
      return [];
    },
    async fetchRefund(paymentId, refundId) {
      return { id: refundId, payment_id: paymentId, amount: 0, status: "processed" };
    },
    async createPartialRefund(paymentId, { amountPaise, receipt }) {
      return { id: demoId("rfnd", `${paymentId}:${receipt}`), payment_id: paymentId, amount: amountPaise, status: "processed", receipt };
    },
    async createPaymentLink(input) {
      const id = demoId("plink", input.referenceId);
      return { id, short_url: demoLinkUrl(id), amount: input.amountPaise, status: "created", reference_id: input.referenceId };
    },
    async cancelPaymentLink() {
      return "cancelled";
    },
    // 046 Route: deterministic ids from our idempotency key (a repeat returns the same transfer). The outcome arrives as
    // a fake signed webhook (lib/payouts/demo.ts): `transfer.failed` for linked accounts whose id contains FAIL,
    // `transfer.processed` otherwise.
    async createTransfer(input) {
      return {
        id: demoId("trf", input.idempotencyKey),
        status: "pending",
        amount: input.amountPaise,
        recipient: input.account,
        on_hold: input.onHold,
        payout_transfer: input.idempotencyKey,
      };
    },
    async listTransfers() {
      return [];
    },
    async releaseTransfer(transferId) {
      return { id: transferId, status: "processed", amount: 0, recipient: "", on_hold: false, payout_transfer: null };
    },
    async createReversal(transferId, { amountPaise }) {
      return { id: demoId("rvrsl", transferId), transfer_id: transferId, amount: amountPaise };
    },
    async listReversals() {
      return [];
    },
  };
}

let gatewayOverride: PaymentGateway | null = null;

/** Tests: replace the gateway (null restores the configured one). */
export function setPaymentGatewayForTests(gateway: PaymentGateway | null): void {
  gatewayOverride = gateway;
}

/** The configured gateway (demo in DEMO_MODE, Razorpay test mode otherwise). Throws RazorpayConfigError. */
export function getPaymentGateway(settings: RazorpaySettings = razorpaySettings()): PaymentGateway {
  if (gatewayOverride) return gatewayOverride;
  return settings.mode === "demo" ? createDemoGateway() : createRazorpayClient({ keyId: settings.keyId, keySecret: settings.keySecret });
}
