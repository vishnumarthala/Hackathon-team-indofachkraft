// Ticket 031: Razorpay client (test mode only, D-1), the demo gateway (DEMO_MODE) and signature checks.
// No SDK: Orders + Refunds over HTTPS with basic auth. Server-only (node:crypto, secrets).
//   * Checkout signature (FR-4): HMAC_SHA256(order_id + "|" + payment_id, key_secret), hex.
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
export type GatewayRefund = { id: string; payment_id: string; amount: number; status: "pending" | "processed" | "failed" };

export interface PaymentGateway {
  readonly kind: "razorpay" | "demo";
  readonly keyId: string;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  /** Full refund of a captured payment. */
  createRefund(paymentId: string, input: { amountPaise: number; receipt: string }): Promise<GatewayRefund>;
  listRefunds(paymentId: string): Promise<GatewayRefund[]>;
  fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function refundOf(json: Record<string, unknown>): GatewayRefund {
  const status = json.status === "processed" || json.status === "failed" ? json.status : "pending";
  return { id: String(json.id), payment_id: String(json.payment_id), amount: Number(json.amount), status };
}

/** Real Razorpay (test mode). Refuses to be created with a non-test key id (D-1). */
export function createRazorpayClient(opts: { keyId: string; keySecret: string; fetchImpl?: FetchLike; baseUrl?: string }): PaymentGateway {
  if (!opts.keyId) throw new RazorpayConfigError("RAZORPAY_KEY_ID is missing.");
  assertTestKey(opts.keyId);
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl ?? RAZORPAY_API;
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64")}`;

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
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
  };
}

/** Deterministic Razorpay-shaped id (`order_DEMO…`, `pay_DEMO…`, `rfnd_DEMO…`) from a seed. */
export function demoId(prefix: "order" | "pay" | "rfnd", seed: string): string {
  return `${prefix}_DEMO${createHash("sha256").update(`${prefix}:${seed}`).digest("hex").slice(0, 14)}`;
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
