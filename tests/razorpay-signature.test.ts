// Ticket 031: Razorpay signatures (checkout + webhook: valid, tampered, wrong secret), constant-time comparison, test
// keys only (rzp_live_ rejected by the client, the settings and at server start-up), the demo gateway, the HTTP
// client against a mocked fetch, webhook payload stripping (no card/UPI details stored), the per-route CSP exception
// and the payment labels. Pure: no database.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const crypto = vi.hoisted(() => ({ timingSafeEqual: null as null | ReturnType<typeof vi.fn> }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const timingSafeEqual = vi.fn(actual.timingSafeEqual);
  crypto.timingSafeEqual = timingSafeEqual;
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

import {
  assertTestKey,
  checkoutSignature,
  createDemoGateway,
  createRazorpayClient,
  demoId,
  RazorpayApiError,
  RazorpayConfigError,
  razorpaySettings,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "@/lib/payments/razorpay";
import { parseWebhook } from "@/lib/payments/webhook";
import { paymentLabel } from "@/lib/payments/display";
import { familyCsp } from "@/lib/csp";
import { allowedOriginsFor, scriptAllowed } from "@/lib/privacy/third-party-allowlist";
import { register } from "@/instrumentation";

const KEY_SECRET = "test_key_secret_031";
const WEBHOOK_SECRET = "test_webhook_secret_031";
const ORDER = "order_Test031abcdef";
const PAYMENT = "pay_Test031abcdef";
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

afterEach(() => {
  vi.unstubAllEnvs();
  crypto.timingSafeEqual?.mockClear();
});

describe("checkout signature (FR-4)", () => {
  const good = hmac(KEY_SECRET, `${ORDER}|${PAYMENT}`);

  it("is HMAC_SHA256(order_id|payment_id, key_secret) in hex", () => {
    expect(checkoutSignature(ORDER, PAYMENT, KEY_SECRET)).toBe(good);
  });

  it("accepts the valid signature", () => {
    expect(verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: good }, KEY_SECRET)).toBe(true);
  });

  it("rejects a tampered payment id, order id or signature", () => {
    expect(verifyCheckoutSignature({ orderId: ORDER, paymentId: "pay_Other031abcdef", signature: good }, KEY_SECRET)).toBe(false);
    expect(verifyCheckoutSignature({ orderId: "order_Other031abcd", paymentId: PAYMENT, signature: good }, KEY_SECRET)).toBe(false);
    const flipped = `${good.slice(0, -1)}${good.endsWith("0") ? "1" : "0"}`;
    expect(verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: flipped }, KEY_SECRET)).toBe(false);
    expect(verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: "" }, KEY_SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const wrong = hmac("another-secret", `${ORDER}|${PAYMENT}`);
    expect(verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: wrong }, KEY_SECRET)).toBe(false);
  });

  it("compares in constant time (crypto.timingSafeEqual)", () => {
    verifyCheckoutSignature({ orderId: ORDER, paymentId: PAYMENT, signature: good }, KEY_SECRET);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});

describe("webhook signature (FR-5)", () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: PAYMENT, order_id: ORDER, amount: 50000 } } } });
  const good = hmac(WEBHOOK_SECRET, body);

  it("accepts HMAC_SHA256(raw body, webhook secret)", () => {
    expect(verifyWebhookSignature(body, good, WEBHOOK_SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, good.toUpperCase(), WEBHOOK_SECRET)).toBe(true);
  });

  it("rejects a tampered body (even whitespace)", () => {
    expect(verifyWebhookSignature(body.replace("50000", "100"), good, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(`${body} `, good, WEBHOOK_SECRET)).toBe(false);
  });

  it("rejects the wrong secret, a missing signature and a missing secret", () => {
    expect(verifyWebhookSignature(body, hmac("wrong", body), WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, null, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, good, null)).toBe(false);
    expect(verifyWebhookSignature(body, good, "")).toBe(false);
  });

  it("compares in constant time (crypto.timingSafeEqual)", () => {
    verifyWebhookSignature(body, good, WEBHOOK_SECRET);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});

describe("test mode only (D-1)", () => {
  it("rejects rzp_live_ keys everywhere", () => {
    expect(() => assertTestKey("rzp_live_ABC123")).toThrow(RazorpayConfigError);
    expect(() => assertTestKey("ABC123")).toThrow(RazorpayConfigError);
    expect(() => assertTestKey("rzp_test_ABC123")).not.toThrow();
    expect(() => createRazorpayClient({ keyId: "rzp_live_ABC123", keySecret: "s" })).toThrow(/rzp_test_/);
  });

  it("razorpaySettings refuses a live key even in DEMO_MODE", () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_ABC123");
    expect(() => razorpaySettings()).toThrow(RazorpayConfigError);
  });

  it("the server refuses to start with a live key (instrumentation register)", () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_ABC123");
    expect(() => register()).toThrow(/rzp_test_/);
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_ABC123");
    expect(() => register()).not.toThrow();
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    expect(() => register()).not.toThrow();
  });

  it("outside DEMO_MODE the keys are required; DEMO_MODE uses the demo gateway with a test-shaped key id", () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    expect(() => razorpaySettings()).toThrow(/not configured/);
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_ABC123");
    vi.stubEnv("RAZORPAY_KEY_SECRET", KEY_SECRET);
    expect(razorpaySettings()).toMatchObject({ mode: "razorpay", keyId: "rzp_test_ABC123", keySecret: KEY_SECRET, webhookSecret: null });
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-for-test");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    const demo = razorpaySettings();
    expect(demo.mode).toBe("demo");
    expect(demo.keyId.startsWith("rzp_test_")).toBe(true);
    expect(demo.keySecret).toMatch(/^[0-9a-f]{64}$/);
    expect(demo.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("demo gateway", () => {
  it("returns deterministic Razorpay-shaped ids and processes refunds at once", async () => {
    const gw = createDemoGateway();
    const a = await gw.createOrder({ amountPaise: 50000, receipt: "appt-1", notes: {} });
    const b = await gw.createOrder({ amountPaise: 50000, receipt: "appt-1", notes: {} });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^order_DEMO[0-9a-f]{14}$/);
    expect(demoId("pay", a.id)).toMatch(/^pay_DEMO[0-9a-f]{14}$/);
    const refund = await gw.createRefund(demoId("pay", a.id), { amountPaise: 50000, receipt: "r" });
    expect(refund).toMatchObject({ status: "processed", amount: 50000 });
    expect(refund.id).toMatch(/^rfnd_DEMO/);
  });
});

describe("Razorpay HTTP client (mocked fetch)", () => {
  it("creates orders with basic auth and maps errors (retryable for 5xx / network)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/orders")) return new Response(JSON.stringify({ id: "order_Real031abcdef", amount: 50000, currency: "INR", receipt: "a1", status: "created" }), { status: 200 });
      if (url.includes("/refunds")) return new Response(JSON.stringify({ items: [{ id: "rfnd_Real031abcdef", payment_id: PAYMENT, amount: 50000, status: "processed" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "SERVER_ERROR" } }), { status: 502 });
    });
    const client = createRazorpayClient({ keyId: "rzp_test_ABC123", keySecret: KEY_SECRET, fetchImpl });
    const order = await client.createOrder({ amountPaise: 50000, receipt: "a1", notes: { appointment_id: "a1" } });
    expect(order.id).toBe("order_Real031abcdef");
    expect(calls[0].url).toBe("https://api.razorpay.com/v1/orders");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`rzp_test_ABC123:${KEY_SECRET}`).toString("base64")}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ amount: 50000, currency: "INR", receipt: "a1", notes: { appointment_id: "a1" } });
    expect((await client.listRefunds(PAYMENT))[0]).toMatchObject({ id: "rfnd_Real031abcdef", status: "processed" });
    const err = await client.createRefund(PAYMENT, { amountPaise: 50000, receipt: "r" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RazorpayApiError);
    expect(err).toMatchObject({ status: 502, code: "SERVER_ERROR", retryable: true });
    const down = createRazorpayClient({ keyId: "rzp_test_ABC123", keySecret: KEY_SECRET, fetchImpl: async () => Promise.reject(new Error("ECONNRESET")) });
    await expect(down.createOrder({ amountPaise: 100, receipt: "x", notes: {} })).rejects.toMatchObject({ code: "network_error", retryable: true });
  });
});

describe("webhook payload stripping (NFR-1)", () => {
  it("keeps ids, amounts and statuses; drops card, VPA, bank, wallet, email, phone and notes", () => {
    const raw = JSON.stringify({
      entity: "event",
      account_id: "acc_Synthetic",
      event: "payment.captured",
      contains: ["payment"],
      created_at: 1763000000,
      payload: {
        payment: {
          entity: {
            id: PAYMENT,
            entity: "payment",
            order_id: ORDER,
            amount: 50000,
            currency: "INR",
            status: "captured",
            method: "upi",
            captured: true,
            vpa: "synthetic.parent@okbank",
            email: "parent@example.test",
            contact: "+919876543210",
            card_id: "card_Synthetic",
            card: { last4: "1111", network: "Visa", name: "Synthetic Parent" },
            bank: "HDFC",
            wallet: "paytm",
            notes: { appointment_id: "x", child: "Synthetic Child" },
            description: "Synthetic Child speech therapy",
            acquirer_data: { rrn: "123456789012", upi_transaction_id: "UPI123" },
            upi: { vpa: "synthetic.parent@okbank" },
            error_code: null,
          },
        },
      },
    });
    const parsed = parseWebhook(raw);
    expect(parsed.payment).toMatchObject({ id: PAYMENT, order_id: ORDER, amount: 50000, status: "captured" });
    const stored = JSON.stringify(parsed.stored);
    for (const secret of ["okbank", "example.test", "9876543210", "card_", "1111", "Visa", "HDFC", "paytm", "Synthetic Child", "Synthetic Parent", "123456789012", "UPI123", "acc_Synthetic"]) {
      expect(stored).not.toContain(secret);
    }
    expect(parsed.stored).toEqual({
      event: "payment.captured",
      created_at: 1763000000,
      payment: { id: PAYMENT, entity: "payment", order_id: ORDER, status: "captured", amount: 50000, currency: "INR", method: "upi", captured: true, error_code: null },
    });
  });

  it("parses refunds and failures; rejects non-events", () => {
    const refund = parseWebhook(JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_Test031abcdef", payment_id: PAYMENT, amount: 50000, status: "processed", notes: { x: "y" } } } } }));
    expect(refund.refund).toEqual({ id: "rfnd_Test031abcdef", payment_id: PAYMENT, status: "processed" });
    const failed = parseWebhook(JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: PAYMENT, order_id: ORDER, status: "failed", error_code: "BAD_REQUEST_ERROR", error_reason: "payment_failed", error_description: "Card 4111 declined" } } } }));
    expect(failed.payment?.error).toBe("BAD_REQUEST_ERROR: payment_failed");
    expect(JSON.stringify(failed.stored)).not.toContain("4111");
    expect(() => parseWebhook("[]")).toThrow();
    expect(() => parseWebhook("{}")).toThrow();
    expect(() => parseWebhook("not json")).toThrow();
  });
});

describe("checkout script allowed on the payment route only (grill Q3, 041)", () => {
  const csp = (pathname: string) => familyCsp({ pathname, nonce: "n", supabaseUrl: "http://127.0.0.1:54321", isDev: false });
  const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("adds Razorpay to script-src, frame-src and connect-src on /book/<profile>/pay/<appointment>", () => {
    const policy = csp("/book/11111111-1111-1111-1111-111111111111/pay/22222222-2222-2222-2222-222222222222");
    expect(directive(policy, "script-src")).toContain("https://checkout.razorpay.com");
    expect(directive(policy, "frame-src")).toContain("https://api.razorpay.com");
    expect(directive(policy, "connect-src")).toContain("https://api.razorpay.com");
  });

  it("keeps every other booking and family page free of it", () => {
    for (const path of ["/book/11111111-1111-1111-1111-111111111111", "/family/appointments", "/family", "/book/x/pay"]) {
      const policy = csp(path);
      expect(policy, path).not.toContain("razorpay");
      expect(directive(policy, "frame-src"), path).toBe("frame-src 'none'");
    }
  });

  it("the 041 allowlist agrees", () => {
    const pay = "/book/11111111-1111-1111-1111-111111111111/pay/22222222-2222-2222-2222-222222222222";
    expect(allowedOriginsFor(pay)).toContain("https://checkout.razorpay.com");
    expect(scriptAllowed("https://checkout.razorpay.com/v1/checkout.js", pay, "http://localhost:3000")).toBe(true);
    expect(scriptAllowed("https://checkout.razorpay.com/v1/checkout.js", "/book/11111111-1111-1111-1111-111111111111", "http://localhost:3000")).toBe(false);
  });
});

describe("payment labels (FR-8)", () => {
  const appt = (status: string, payment_mode: "online" | "at_clinic" | "free") => ({ status, service_snapshot: { payment_mode } });

  it("guardian: Paid / Payment pending / Refunded; provider: Paid online / Pay at clinic", () => {
    expect(paymentLabel(appt("confirmed", "online"), { status: "captured" }, "guardian")).toBe("paid");
    expect(paymentLabel(appt("confirmed", "online"), { status: "captured" }, "provider")).toBe("paidOnline");
    expect(paymentLabel(appt("pending_payment", "online"), null, "guardian")).toBe("pending");
    expect(paymentLabel(appt("pending_payment", "online"), { status: "failed" }, "guardian")).toBe("pending");
    expect(paymentLabel(appt("expired", "online"), { status: "refunded" }, "guardian")).toBe("refunded");
    expect(paymentLabel(appt("cancelled", "online"), { status: "refund_pending" }, "provider")).toBe("refundPending");
    expect(paymentLabel(appt("cancelled", "online"), { status: "captured" }, "guardian")).toBe("notRefunded");
    expect(paymentLabel(appt("confirmed", "at_clinic"), null, "provider")).toBe("atClinic");
    expect(paymentLabel(appt("confirmed", "free"), null, "provider")).toBeNull();
    expect(paymentLabel(appt("expired", "online"), null, "guardian")).toBeNull();
  });
});
