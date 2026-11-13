// Ticket 045 pure rules: per-session value of a package (D-4, remainder on the last session), refund of unused
// sessions, the Indian financial year of receipts (rolls over on 1 April, Asia/Kolkata), FR-8 badges, the payment link
// redirect signature, payment_link webhook parsing (no customer data stored), the desk QR (short URL only, NFR-3),
// the receipt PDF text (FR-6), and "pay at clinic" being refused for new services (FR-2).
import { describe, expect, it } from "vitest";
import { ServiceCreateSchema } from "@/lib/booking/schemas";
import { ledgerItemLabel, ledgerSign } from "@/lib/fees/display";
import { balanceOf, balanceOverdue, financialYear, packageEnding, packageRefundPaise, packageSessionAmount } from "@/lib/fees/money";
import { linkQrSvg } from "@/lib/fees/qr";
import { renderReceiptPdf } from "@/lib/fees/receipt";
import { paymentLinkSignature, verifyPaymentLinkSignature } from "@/lib/payments/razorpay";
import { isHandledEvent, parseWebhook } from "@/lib/payments/webhook";
import { pdfText } from "./helpers/pdf";

describe("D-4 package session value", () => {
  it("12 sessions for ₹9,000: 75000 paise each", () => {
    const amounts = Array.from({ length: 12 }, (_, i) => packageSessionAmount(900000, 12, i + 1));
    expect(new Set(amounts)).toEqual(new Set([75000]));
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(900000);
  });

  it("₹10,000 / 12: rounded down, remainder on the last session", () => {
    const amounts = Array.from({ length: 12 }, (_, i) => packageSessionAmount(1000000, 12, i + 1));
    expect(amounts.slice(0, 11)).toEqual(Array(11).fill(83333));
    expect(amounts[11]).toBe(83337);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1000000);
  });

  it("refuses sessions outside the package", () => {
    expect(() => packageSessionAmount(900000, 12, 13)).toThrow();
    expect(() => packageSessionAmount(900000, 12, 0)).toThrow();
  });
});

describe("FR-9 refund of unused sessions", () => {
  it("price minus the used sessions' consultation amounts (and earlier refunds), never negative", () => {
    expect(packageRefundPaise(900000, [75000, 75000, 75000])).toBe(675000);
    expect(packageRefundPaise(1000000, [...Array(11).fill(83333)])).toBe(83337);
    expect(packageRefundPaise(900000, [75000], 100000)).toBe(725000);
    expect(packageRefundPaise(900000, Array(12).fill(75000))).toBe(0);
  });
});

describe("FR-6 financial year (receipts)", () => {
  it("rolls over on 1 April in Asia/Kolkata", () => {
    expect(financialYear(new Date("2027-03-31T23:59:59+05:30"))).toBe("2026-27");
    expect(financialYear(new Date("2027-04-01T00:00:00+05:30"))).toBe("2027-28");
    // 31 March 18:30 UTC is already 1 April in India.
    expect(financialYear(new Date("2027-03-31T18:30:00Z"))).toBe("2027-28");
    expect(financialYear(new Date("2026-11-14T10:00:00+05:30"))).toBe("2026-27");
    expect(financialYear(new Date("2100-01-15T10:00:00+05:30"))).toBe("2099-00");
  });
});

describe("ledger balance and labels", () => {
  it("charges add, payments subtract, adjustments are signed, refunds do not move the balance", () => {
    expect(
      balanceOf([
        { kind: "charge", amount_paise: 80000 },
        { kind: "payment", amount_paise: 80000 },
        { kind: "refund", amount_paise: 80000 },
        { kind: "charge", amount_paise: 80000 },
        { kind: "adjustment", amount_paise: -10000 },
      ]),
    ).toBe(70000);
    expect(ledgerSign({ kind: "adjustment", amount_paise: -100 })).toBe("-");
    expect(ledgerSign({ kind: "charge", amount_paise: 100 })).toBe("+");
  });

  it("labels system rows and keeps a manual adjustment's reason", () => {
    const t = (key: string, v?: Record<string, string | number>) => `${key}${v ? JSON.stringify(v) : ""}`;
    const f = { date: () => "14 Nov" };
    expect(ledgerItemLabel({ kind: "charge", note: "session", session_at: "2026-11-14T04:30:00Z", package_name: null, manual: false }, t, f)).toBe('items.session{"date":"14 Nov"}');
    expect(ledgerItemLabel({ kind: "adjustment", note: "Sibling goodwill", session_at: null, package_name: null, manual: true }, t, f)).toBe("Sibling goodwill");
    expect(ledgerItemLabel({ kind: "payment", note: "package", session_at: null, package_name: "12 sessions", manual: false }, t, f)).toBe('items.package{"name":"12 sessions"}');
  });
});

describe("FR-8 badges", () => {
  it("package ending: <= 2 sessions left or expiring within 7 days", () => {
    expect(packageEnding({ sessions_total: 12, sessions_used: 10, expires_on: "2026-12-31" }, "2026-11-14")).toBe(true);
    expect(packageEnding({ sessions_total: 12, sessions_used: 3, expires_on: "2026-11-20" }, "2026-11-14")).toBe(true);
    expect(packageEnding({ sessions_total: 12, sessions_used: 3, expires_on: "2026-11-30" }, "2026-11-14")).toBe(false);
  });

  it("balance overdue 3 days after the session", () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    expect(balanceOverdue("2026-11-11T09:59:00Z", now)).toBe(true);
    expect(balanceOverdue("2026-11-12T10:00:00Z", now)).toBe(false);
    expect(balanceOverdue(null, now)).toBe(false);
  });
});

describe("payment links", () => {
  const SECRET = "t045_key_secret_synthetic";
  const input = { linkId: "plink_T045abcdef01", referenceId: "0f0e", status: "paid", paymentId: "pay_T045abcdef01" };

  it("redirect signature = HMAC_SHA256(link|reference|status|payment); tampering fails", () => {
    const signature = paymentLinkSignature(input, SECRET);
    expect(verifyPaymentLinkSignature({ ...input, signature }, SECRET)).toBe(true);
    expect(verifyPaymentLinkSignature({ ...input, status: "partially_paid", signature }, SECRET)).toBe(false);
    expect(verifyPaymentLinkSignature({ ...input, paymentId: "pay_T045other0001", signature }, SECRET)).toBe(false);
    expect(verifyPaymentLinkSignature({ ...input, signature }, "other")).toBe(false);
    expect(verifyPaymentLinkSignature({ ...input, signature: "" }, SECRET)).toBe(false);
  });

  it("payment_link.paid is handled; the stored copy keeps no customer, contact, description or short URL", () => {
    expect(isHandledEvent("payment_link.paid")).toBe(true);
    const parsed = parseWebhook(
      JSON.stringify({
        event: "payment_link.paid",
        created_at: 1794000000,
        payload: {
          payment_link: {
            entity: {
              id: "plink_T045abcdef01",
              entity: "payment_link",
              amount: 900000,
              amount_paid: 900000,
              status: "paid",
              reference_id: "abc",
              short_url: "https://rzp.io/i/T045abc",
              description: "Child Name (synthetic) package",
              customer: { name: "Parent (synthetic)", contact: "+919876543210", email: "parent@example.test" },
            },
          },
          payment: { entity: { id: "pay_T045abcdef01", amount: 900000, order_id: "order_T045abcdef01", status: "captured", vpa: "parent@okbank", created_at: 1794000000 } },
        },
      }),
    );
    expect(parsed.paymentLink).toEqual({ id: "plink_T045abcdef01", status: "paid", amount: 900000 });
    expect(parsed.payment).toMatchObject({ id: "pay_T045abcdef01", amount: 900000, created_at: 1794000000 });
    const stored = JSON.stringify(parsed.stored);
    for (const secret of ["Parent (synthetic)", "+919876543210", "parent@example.test", "parent@okbank", "rzp.io", "Child Name"]) expect(stored).not.toContain(secret);
  });

  it("NFR-3: the QR encodes the short URL only; anything with a query or other text is refused", async () => {
    const svg = await linkQrSvg("https://rzp.io/i/T045abc");
    expect(svg.startsWith("<svg")).toBe(true);
    await expect(linkQrSvg("https://rzp.io/i/T045abc?child=Asha")).rejects.toThrow();
    await expect(linkQrSvg("Pay for Asha")).rejects.toThrow();
  });
});

describe("FR-6 receipt PDF", () => {
  it('reads "Paid to DoctorNearMe on behalf of <centre>" with items, amount, Razorpay payment id and date', async () => {
    const bytes = await renderReceiptPdf({
      payment_id: "00000000-0000-4000-8000-000000000045",
      receipt_no: "DNM/2026-27/000001",
      captured_at: "2026-11-14T05:00:00Z",
      org_name: "E045 Centre (synthetic)",
      amount_paise: 900000,
      razorpay_payment_id: "pay_DEMO045abcdef",
      purpose: "package",
      items: [{ label: "Package: Speech 12 (12 sessions)", amount_paise: 900000 }],
      refunded_paise: 0,
    });
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(bytes);
    expect(text).toContain("Receipt no. DNM/2026-27/000001");
    expect(text).toContain("Paid to DoctorNearMe on behalf of E045 Centre (synthetic)");
    expect(text).toContain("Package: Speech 12 (12 sessions)");
    expect(text).toContain("Rs. 9,000");
    expect(text).toContain("Razorpay payment id: pay_DEMO045abcdef");
    expect(text).toContain("14 Nov 2026");
  });
});

describe("FR-2 pay at clinic is retired", () => {
  const base = { name: "Speech (synthetic)", mode: "video" as const, duration_min: 30, buffer_min: 0 };
  it("new services can only be online (with a fee) or free", () => {
    expect(ServiceCreateSchema.safeParse({ ...base, fee_inr: 800, payment_mode: "at_clinic" }).success).toBe(false);
    expect(ServiceCreateSchema.safeParse({ ...base, fee_inr: 0, payment_mode: "online" }).success).toBe(false);
    expect(ServiceCreateSchema.safeParse({ ...base, fee_inr: 800, payment_mode: "online" }).success).toBe(true);
    expect(ServiceCreateSchema.safeParse({ ...base, fee_inr: 0, payment_mode: "free" }).success).toBe(true);
  });
});
