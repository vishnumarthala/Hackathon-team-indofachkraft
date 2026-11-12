// Ticket 018 FR-5/FR-5a: locale-aware formatting in the viewer's time zone, Latin digits, Indian grouping.
import { describe, expect, it } from "vitest";
import { createFormatter, formatDate, formatDateTime, formatInr, formatNumber, formatTime } from "@/lib/i18n/format";

const EVENING_UTC = "2026-11-12T20:00:00Z";
const LATIN_ONLY = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Devanagari}\p{Script=Telugu}\s]*$/u;
const NON_LATIN_DIGITS = /[०-९౦-౯]/;

describe("formatInr", () => {
  it("formats paise as rupees with Indian digit grouping", () => {
    expect(formatInr(15000000, "en")).toBe("₹1,50,000");
    expect(formatInr(150000, "en")).toBe("₹1,500");
    expect(formatInr(150050, "en")).toBe("₹1,500.50");
    expect(formatInr(15000000, "hi")).toBe("₹1,50,000");
    expect(formatInr(15000000, "te")).toBe("₹1,50,000");
  });
});

describe("formatNumber", () => {
  it("uses Indian grouping and Latin digits in every locale", () => {
    for (const locale of ["en", "hi", "te"] as const) expect(formatNumber(1234567.5, locale)).toBe("12,34,567.5");
  });
});

describe("dates in the viewer's time zone", () => {
  it("a UTC evening is already the next day in Asia/Kolkata", () => {
    expect(formatDate(EVENING_UTC, "en", "short", "Asia/Kolkata")).toBe("13 Nov 2026");
    expect(formatDate(EVENING_UTC, "en", "long", "Asia/Kolkata")).toBe("13 November 2026");
    expect(formatDate(EVENING_UTC, "en", "short", "Europe/Berlin")).toBe("12 Nov 2026");
  });

  it("times always carry the zone abbreviation", () => {
    expect(formatTime(EVENING_UTC, "en", "Asia/Kolkata")).toBe("1:30 am IST");
    expect(formatDateTime(EVENING_UTC, "en", "Asia/Kolkata")).toBe("13 Nov 2026, 1:30 am IST");
    expect(formatDateTime("2026-11-12T05:00:00Z", "en", "Europe/Berlin")).toMatch(/6:00 am GMT\+1$/);
  });

  it("hi and te use their month names but Latin digits", () => {
    for (const locale of ["hi", "te"] as const) {
      const outputs = [
        formatDate(EVENING_UTC, locale, "short", "Asia/Kolkata"),
        formatDate(EVENING_UTC, locale, "long", "Asia/Kolkata"),
        formatDateTime(EVENING_UTC, locale, "Asia/Kolkata"),
        formatTime(EVENING_UTC, locale, "Asia/Kolkata"),
      ];
      for (const out of outputs) {
        expect(out).toMatch(/13|1:30/);
        expect(out).not.toMatch(NON_LATIN_DIGITS);
        expect(out).toMatch(LATIN_ONLY);
      }
    }
    expect(formatDate(EVENING_UTC, "hi", "long", "Asia/Kolkata")).toBe("13 नवंबर 2026");
    expect(formatDate(EVENING_UTC, "te", "long", "Asia/Kolkata")).toContain("నవంబర్");
  });

  it("createFormatter binds locale and zone (getFormatter / useFormatter)", () => {
    const f = createFormatter("en", "Asia/Kolkata");
    expect(f.date(EVENING_UTC)).toBe("13 Nov 2026");
    expect(f.dateTime(EVENING_UTC)).toBe("13 Nov 2026, 1:30 am IST");
    expect(f.inr(15000000)).toBe("₹1,50,000");
    expect(f.number(100000)).toBe("1,00,000");
  });
});
