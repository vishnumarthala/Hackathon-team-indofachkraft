import { describe, expect, it } from "vitest";
import { buildIntakeShare, intakeEmailSubject, intakeMessage, intakeUrl, whatsappUrl } from "@/lib/intake/message";

const c = { parent_alias: "Lakshmi", therapist_name: "Demo Therapist", child_alias: "Ravi" };
const url = "http://localhost:3000/intake/abc_DEF-123";
const expected =
  "Hello Lakshmi, this is Demo Therapist's team at CareThread. Before Ravi's first session, please take a short voice call (about 15 minutes) with our AI assistant in Telugu, Hindi or English: http://localhost:3000/intake/abc_DEF-123";

describe("intake message", () => {
  it("builds the URL from the app URL, ignoring trailing slashes", () => {
    expect(intakeUrl("http://localhost:3000", "abc_DEF-123")).toBe(url);
    expect(intakeUrl("http://localhost:3000//", "abc_DEF-123")).toBe(url);
  });

  it("uses the exact message text", () => {
    expect(intakeMessage(c, url)).toBe(expected);
  });

  it("encodes the message for WhatsApp with the phone's digits only", () => {
    const wa = whatsappUrl("+91 98765 43210", expected);
    expect(wa).toBe(`https://wa.me/919876543210?text=${encodeURIComponent(expected)}`);
    expect(wa).not.toContain(" ");
    expect(wa).toContain("Demo%20Therapist's%20team");
    expect(decodeURIComponent(new URL(wa).searchParams.get("text")!)).toBe(expected);
  });

  it("uses wa.me/?text= without a phone", () => {
    expect(whatsappUrl(null, expected)).toBe(`https://wa.me/?text=${encodeURIComponent(expected)}`);
    expect(whatsappUrl("", expected)).toBe(`https://wa.me/?text=${encodeURIComponent(expected)}`);
  });

  it("encodes characters that would break the URL", () => {
    const tricky = intakeMessage({ ...c, parent_alias: "A&B #1?" }, url);
    const wa = whatsappUrl(undefined, tricky);
    expect(new URL(wa).searchParams.get("text")).toBe(tricky);
  });

  it("buildIntakeShare combines url, message and WhatsApp link; subject text", () => {
    const share = buildIntakeShare({ ...c, parent_phone: null }, "http://localhost:3000", "abc_DEF-123");
    expect(share).toEqual({ url, message: expected, whatsapp_url: `https://wa.me/?text=${encodeURIComponent(expected)}` });
    expect(intakeEmailSubject("Ravi")).toBe("Your CareThread intake call for Ravi");
  });
});
