// Ticket 055: free pilot mode (PAYMENTS_ENABLED not "true"). Unit level: the switch, the 404 / 409 / skip gates of the
// fee, payout and payment routes and pages, the booking flow copy and the suppressed payment notifications. The
// database side (direct confirmation, no charges at attendance, no enqueue / fan-out / delivery) is covered in
// booking-state-machine, fees-flow and outbox.
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "./helpers/i18n";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
}));

const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const id = randomUUID();
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => vi.stubEnv("PAYMENTS_ENABLED", ""));
afterEach(() => vi.unstubAllEnvs());

describe("the switch", () => {
  it("only the exact string \"true\" turns payments on; unset is the free pilot", async () => {
    const { env } = await import("@/lib/env");
    const { paymentsEnabled } = await import("@/lib/payments/mode");
    for (const value of ["", "1", "yes", "TRUE", "false"]) {
      vi.stubEnv("PAYMENTS_ENABLED", value);
      expect(env.PAYMENTS_ENABLED).toBe(false);
      expect(paymentsEnabled()).toBe(false);
    }
    vi.stubEnv("PAYMENTS_ENABLED", "true");
    expect(paymentsEnabled()).toBe(true);
  });

  it("is not inferred from DEMO_MODE or the Razorpay keys", async () => {
    const { paymentsEnabled } = await import("@/lib/payments/mode");
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_abc123");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "secret");
    expect(paymentsEnabled()).toBe(false);
  });
});

describe("pages", () => {
  it("fee, package, payment and payout pages are 404", async () => {
    const pages: [() => Promise<unknown>][] = [
      [async () => (await import("@/app/dashboard/fees/page")).default()],
      [async () => (await import("@/app/dashboard/payouts/page")).default({ searchParams: Promise.resolve({}) })],
      [async () => (await import("@/app/admin/payouts/page")).default()],
      [async () => (await import("@/app/dashboard/settings/packages/page")).default({ searchParams: Promise.resolve({}) })],
      [async () => (await import("@/app/cases/[id]/fees/page")).default(params({ id }))],
      [async () => (await import("@/app/family/(portal)/children/[id]/payments/page")).default({ ...params({ id }), searchParams: Promise.resolve({}) })],
      [async () => (await import("@/app/pay/done/page")).default({ searchParams: Promise.resolve({}) })],
      [async () => (await import("@/app/pay/demo/[linkId]/page")).default(params({ linkId: "plink_abcdef12" }))],
    ];
    for (const [render] of pages) await expect(render()).rejects.toMatchObject({ digest: NOT_FOUND });
  });

  it("the checkout page sends the family to the appointment page instead", async () => {
    const PayPage = (await import("@/app/book/[profileId]/pay/[appointmentId]/page")).default;
    const appointmentId = randomUUID();
    await expect(PayPage(params({ profileId: randomUUID(), appointmentId }))).rejects.toMatchObject({
      digest: expect.stringContaining(`/family/appointments/${appointmentId}`),
    });
  });
});

describe("APIs", () => {
  it("fee, package, payout and payment-link APIs answer 404 payments_disabled before any other check", async () => {
    const req = () => new Request("http://localhost/x", { method: "POST", body: "{}" });
    const responses = [
      await (await import("@/app/api/cases/[id]/fees/route")).GET(req(), params({ id })),
      await (await import("@/app/api/cases/[id]/fees/request-payment/route")).POST(req(), params({ id })),
      await (await import("@/app/api/fees/payments/[id]/qr/route")).GET(req(), params({ id })),
      await (await import("@/app/api/orgs/[id]/packages/route")).POST(req(), params({ id })),
      await (await import("@/app/api/orgs/[id]/payouts/route")).GET(req(), params({ id })),
      await (await import("@/app/api/orgs/[id]/payouts/accept/route")).POST(req(), params({ id })),
      await (await import("@/app/api/admin/payouts/route")).GET(),
      await (await import("@/app/api/payments/links/callback/route")).GET(new Request("http://localhost/api/payments/links/callback")),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ code: "payments_disabled" });
    }
  });

  it("booking payment APIs answer 409 payments_disabled (no order is created)", async () => {
    const responses = [
      await (await import("@/app/api/appointments/[id]/payment-order/route")).POST(new Request("http://localhost/x", { method: "POST" }), params({ id })),
      await (await import("@/app/api/payments/verify/route")).POST(new Request("http://localhost/x", { method: "POST", body: "{}" })),
      await (await import("@/app/api/payments/demo/route")).POST(new Request("http://localhost/x", { method: "POST", body: "{}" })),
    ];
    for (const res of responses) {
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: "payments_disabled" });
    }
  });

  it("the payment and payout crons skip (still behind the secret)", async () => {
    vi.stubEnv("CRON_SECRET", "t055-cron");
    const authed = () => new Request("http://localhost/api/cron/x", { headers: { authorization: "Bearer t055-cron" } });
    for (const route of [await import("@/app/api/cron/payments/route"), await import("@/app/api/cron/payouts/route")]) {
      expect((await route.GET(new Request("http://localhost/api/cron/x"))).status).toBe(401);
      const res = await route.GET(authed());
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ skipped: "payments_disabled" });
    }
  });
});

describe("notifications", () => {
  it("payment, fee and payout kinds are suppressed; everything else is not", async () => {
    const { TOPICS, getTopic, paymentNotificationSuppressed, topicEnabled } = await import("@/lib/notify/topics");
    const payment = [
      "payment.refunded",
      "fees.payment_request",
      "fees.receipt",
      "fees.balance_reminder",
      "fees.package_reminder",
      "fees.refunded",
      "payouts.transfer_failed",
      "payouts.reconciliation_alert",
      "payouts.invoice_issued",
    ];
    for (const topic of Object.keys(TOPICS)) {
      const def = getTopic(topic)!;
      expect(paymentNotificationSuppressed(topic), topic).toBe(payment.includes(topic));
      expect(paymentNotificationSuppressed(def.template), def.template).toBe(payment.includes(topic));
      if (payment.includes(topic)) expect(topicEnabled(def)).toBe(false);
    }
    vi.stubEnv("PAYMENTS_ENABLED", "true");
    for (const topic of payment) expect(paymentNotificationSuppressed(topic)).toBe(false);
  });

  it("enqueue of a payment kind writes nothing", async () => {
    const { enqueue, SUPPRESSED_EVENT_ID } = await import("@/lib/notify/outbox");
    const sql = vi.fn(() => {
      throw new Error("must not touch the database");
    });
    const child = randomUUID();
    await expect(
      enqueue(sql as never, { topic: "fees.balance_reminder", aggregateType: "child", aggregateId: child, payload: { org_id: randomUUID(), child_id: child }, dedupKey: "x" }),
    ).resolves.toBe(SUPPRESSED_EVENT_ID);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe("booking flow copy", () => {
  const props = {
    profile: { id: "p", name: "Dr Test (synthetic)", slug: "dr-test" },
    services: [
      { id: "svc", name: "Speech therapy", mode: "in_clinic" as const, duration_min: 30, fee_inr: 800, payment_mode: "online" as const, location_name: null, location_address: null, time_zone: "Asia/Kolkata" },
    ],
    viewer: { signedIn: true, isGuardian: true, hasGoogle: false, children: [{ id: "c1", name: "Child (synthetic)", age: "3 years" }] },
    initialHold: { id: "h1", serviceId: "svc", start: "2099-01-05T04:30:00.000Z", end: "2099-01-05T05:00:00.000Z", expiresAt: "2099-01-05T04:00:00.000Z" },
  };

  it("free pilot: \"Free during the pilot\" and \"Confirm booking\", no fee and no payment step", async () => {
    const { BookingFlow } = await import("@/components/booking/BookingFlow");
    const html = renderToStaticMarkup(withI18n(createElement(BookingFlow, { ...props, freePilot: true })));
    expect(html).toContain("Free during the pilot");
    expect(html).toContain("Confirm booking");
    expect(html).not.toContain("Continue to payment");
    expect(html).not.toContain("₹");
  });

  it("payments on: the fee and Continue to payment", async () => {
    const { BookingFlow } = await import("@/components/booking/BookingFlow");
    const html = renderToStaticMarkup(withI18n(createElement(BookingFlow, props)));
    expect(html).toContain("Continue to payment");
    expect(html).toContain("₹");
    expect(html).not.toContain("Free during the pilot");
  });
});
