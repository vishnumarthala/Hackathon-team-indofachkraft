// Ticket 046: pure payout maths and parsing (no database).
//   * fee maths: percent, flat, min, cap, waiver, GST 18%, net = consultation - fee - GST (E-1, E-2, E-3);
//   * invoice numbers and the Indian financial year, the month the 1st's cron invoices, CGST/SGST vs IGST;
//   * reconciliation arithmetic; CSV cells; transfer webhooks are allowlisted (no notes stored).
import { describe, expect, it } from "vitest";
import {
  csvCell,
  csvLine,
  defaultPolicy,
  financialYear,
  gstLines,
  invoiceNumber,
  isWaived,
  previousMonthIst,
  reconDiff,
  splitFee,
  splitFor,
  type FeePolicy,
} from "@/lib/payouts/fees";
import { demoTransferEventBody, demoTransferOutcome } from "@/lib/payouts/demo";
import { isHandledEvent, parseWebhook } from "@/lib/payments/webhook";

const GST = 1800;
const percent = (bps: number, extra: Partial<FeePolicy> = {}): FeePolicy => ({ ...defaultPolicy(bps), version: 1, ...extra });
const flat = (paise: number, extra: Partial<FeePolicy> = {}): FeePolicy => ({
  kind: "flat",
  percent_bps: null,
  flat_paise: paise,
  min_paise: 0,
  cap_paise: null,
  waived_until: null,
  version: 1,
  ...extra,
});

describe("fee maths (FR-3)", () => {
  it("E-1: 10% of ₹750 -> fee ₹75, GST ₹13.50, net ₹661.50", () => {
    expect(splitFee(75000, percent(1000), { waived: false, gstBps: GST })).toEqual({ fee_paise: 7500, gst_paise: 1350, net_paise: 66150 });
  });

  it("E-2: 10% of ₹1,000 -> fee ₹100, GST ₹18, net ₹882", () => {
    expect(splitFee(100000, percent(1000, { min_paise: 2000 }), { waived: false, gstBps: GST })).toEqual({ fee_paise: 10000, gst_paise: 1800, net_paise: 88200 });
  });

  it("min and cap clamp the fee; half-up rounding to the paisa", () => {
    // 10% of ₹150 = ₹15 < min ₹20.
    expect(splitFee(15000, percent(1000, { min_paise: 2000 }), { waived: false, gstBps: GST })).toEqual({ fee_paise: 2000, gst_paise: 360, net_paise: 12640 });
    // 10% of ₹5,000 = ₹500 > cap ₹300.
    expect(splitFee(500000, percent(1000, { cap_paise: 30000 }), { waived: false, gstBps: GST })).toEqual({ fee_paise: 30000, gst_paise: 5400, net_paise: 464600 });
    // 8.5% of ₹333.33 = 2833.305 paise -> 2833; GST 509.94 -> 510.
    expect(splitFee(33333, percent(850), { waived: false, gstBps: GST })).toEqual({ fee_paise: 2833, gst_paise: 510, net_paise: 29990 });
  });

  it("flat fee (₹60 + GST ₹10.80), never more than the consultation", () => {
    expect(splitFee(80000, flat(6000), { waived: false, gstBps: GST })).toEqual({ fee_paise: 6000, gst_paise: 1080, net_paise: 72920 });
    const tiny = splitFee(5000, flat(6000), { waived: false, gstBps: GST });
    expect(tiny.fee_paise + tiny.gst_paise + tiny.net_paise).toBe(5000);
    expect(tiny.net_paise).toBeGreaterThanOrEqual(0);
    expect(tiny.fee_paise).toBeLessThan(5000);
  });

  it("E-3 waiver: no fee for consultations on or before waived_until; net = consultation", () => {
    const policy = flat(6000, { waived_until: "2026-11-30" });
    expect(isWaived(policy, "2026-11-30")).toBe(true);
    expect(isWaived(policy, "2026-12-01")).toBe(false);
    expect(splitFor(80000, policy, "2026-11-14", GST)).toEqual({ fee_paise: 0, gst_paise: 0, net_paise: 80000, waived: true });
    expect(splitFor(80000, policy, "2026-12-01", GST)).toEqual({ fee_paise: 6000, gst_paise: 1080, net_paise: 72920, waived: false });
  });

  it("net + fee + GST always equals the consultation (property over a grid)", () => {
    for (const amount of [1, 99, 100, 1234, 75000, 83333, 83337, 999999, 10000000]) {
      for (const p of [percent(0), percent(1000), percent(3000, { min_paise: 5000, cap_paise: 50000 }), flat(6000), flat(0)]) {
        const s = splitFee(amount, p, { waived: false, gstBps: GST });
        expect(s.fee_paise + s.gst_paise + s.net_paise).toBe(amount);
        expect(Math.min(s.fee_paise, s.gst_paise, s.net_paise)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("invoices (FR-7)", () => {
  it("DNM-INV/<FY>/<0001>, Indian financial year from 1 April (Asia/Kolkata)", () => {
    expect(invoiceNumber("2026-27", 1)).toBe("DNM-INV/2026-27/0001");
    expect(invoiceNumber("2026-27", 12345)).toBe("DNM-INV/2026-27/12345");
    expect(financialYear(new Date("2026-12-01T00:30:00+05:30"))).toBe("2026-27");
    expect(financialYear(new Date("2027-03-31T18:29:00Z"))).toBe("2026-27");
    expect(financialYear(new Date("2027-03-31T18:30:00Z"))).toBe("2027-28");
  });

  it("the cron on the 1st invoices the previous month (IST)", () => {
    expect(previousMonthIst(new Date("2026-12-01T00:30:00+05:30"))).toBe("2026-11-01");
    expect(previousMonthIst(new Date("2026-11-30T19:00:00Z"))).toBe("2026-11-01");
    expect(previousMonthIst(new Date("2027-01-01T01:00:00+05:30"))).toBe("2026-12-01");
  });

  it("CGST + SGST inside the platform's state, IGST otherwise (or without the centre's GSTIN)", () => {
    expect(gstLines(1351, "36AAAAA0000A1Z5", "36BBBBB1111B1Z5")).toEqual([
      { label: "CGST 9%", paise: 675 },
      { label: "SGST 9%", paise: 676 },
    ]);
    expect(gstLines(1350, "36AAAAA0000A1Z5", "29BBBBB1111B1Z5")).toEqual([{ label: "IGST 18%", paise: 1350 }]);
    expect(gstLines(1350, "36AAAAA0000A1Z5", null)).toEqual([{ label: "IGST 18%", paise: 1350 }]);
  });
});

describe("reconciliation (FR-10) and CSV (FR-7)", () => {
  it("transferred + refunded + platform share - captured", () => {
    expect(reconDiff({ captured_paise: 100000, transferred_paise: 88200, platform_share_paise: 11800, refunded_paise: 0 })).toBe(0);
    expect(reconDiff({ captured_paise: 900000, transferred_paise: 198450, platform_share_paise: 26550, refunded_paise: 675000 })).toBe(0);
    expect(reconDiff({ captured_paise: 100000, transferred_paise: 88200, platform_share_paise: 11900, refunded_paise: 0 })).toBe(100);
  });

  it("CSV cells are quoted when needed and formulas are neutralised", () => {
    expect(csvCell("Speech, OT")).toBe('"Speech, OT"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(null)).toBe("");
    expect(csvLine(["a", 1, null])).toBe("a,1,");
  });
});

describe("Route transfer webhooks (FR-3)", () => {
  it("transfer.processed / transfer.failed are handled; the stored copy has no notes, our id is read from them", () => {
    expect(isHandledEvent("transfer.processed")).toBe(true);
    expect(isHandledEvent("transfer.failed")).toBe(true);
    const ours = "0f5c2a7e-1111-4222-8333-444455556666";
    const body = demoTransferEventBody("transfer.failed", {
      transferId: "trf_DEMO0123456789ab",
      source: "pay_DEMOabcdef123456",
      recipient: "acc_DEMOFAIL000001",
      amountPaise: 66150,
      onHold: false,
      payoutTransfer: ours,
    });
    const parsed = parseWebhook(body.replace('"notes":{', '"notes":{"name":"Ravi child","phone":"+919876543210",'));
    expect(parsed.event).toBe("transfer.failed");
    expect(parsed.transfer).toEqual({
      id: "trf_DEMO0123456789ab",
      source: "pay_DEMOabcdef123456",
      status: "failed",
      payout_transfer: ours,
      error: "BAD_REQUEST_ERROR: linked_account_inactive",
    });
    const stored = JSON.stringify(parsed.stored);
    expect(stored).not.toMatch(/notes|Ravi|9876543210|payout_transfer/);
    expect(parsed.stored.transfer).toMatchObject({ id: "trf_DEMO0123456789ab", amount: 66150, status: "failed" });
  });

  it("a payout_transfer note that is not one of our ids is ignored", () => {
    const body = demoTransferEventBody("transfer.processed", {
      transferId: "trf_DEMO0123456789ab",
      source: null,
      recipient: "acc_DEMO0000000001",
      amountPaise: 100,
      onHold: false,
      payoutTransfer: "'; drop table x; --",
    });
    expect(parseWebhook(body).transfer?.payout_transfer).toBeNull();
  });

  it("the demo gateway fails transfers to linked accounts whose id contains FAIL", () => {
    expect(demoTransferOutcome("acc_DEMOFAIL000001")).toBe("transfer.failed");
    expect(demoTransferOutcome("acc_DEMO5c2a7e11114222")).toBe("transfer.processed");
  });
});
