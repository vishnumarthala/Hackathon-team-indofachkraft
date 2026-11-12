import { describe, expect, it } from "vitest";
import {
  fieldErrors,
  isHoneypotFilled,
  MSG,
  PilotSignupSchema,
} from "@/lib/pilots";

const valid = { name: "Test Therapist", email: "t1@example.com", role: "therapist", country: "India" };

function errorsFor(input: unknown) {
  const r = PilotSignupSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? {} : fieldErrors(r.error);
}

describe("PilotSignupSchema", () => {
  it("accepts a minimal valid sign-up", () => {
    expect(PilotSignupSchema.safeParse(valid).success).toBe(true);
  });

  it("returns every FR-3 message for the eval's bad body", () => {
    expect(errorsFor({ name: "", email: "x", role: "boss", country: "", clinicians: 0 })).toEqual({
      name: MSG.name,
      email: MSG.email,
      role: MSG.role,
      country: MSG.country,
      clinicians: MSG.clinicians,
    });
  });

  it("uses the same messages when required fields are missing", () => {
    expect(errorsFor({})).toEqual({
      name: MSG.name,
      email: MSG.email,
      role: MSG.role,
      country: MSG.country,
    });
  });

  it("treats a blank name as missing", () => {
    expect(errorsFor({ ...valid, name: "   " }).name).toBe("Name is required");
  });

  it("trims and lower-cases the email", () => {
    const r = PilotSignupSchema.parse({ ...valid, email: "  T3000-1@Example.COM " });
    expect(r.email).toBe("t3000-1@example.com");
  });

  it("rejects an invalid email", () => {
    expect(errorsFor({ ...valid, email: "not-an-email" }).email).toBe("Enter a valid email");
  });

  it("rejects an unknown role", () => {
    expect(errorsFor({ ...valid, role: "boss" }).role).toBe("Choose who you are");
  });

  it("rejects a one-letter country", () => {
    expect(errorsFor({ ...valid, country: "X" }).country).toBe("Country is required");
  });

  it.each([0, 1001, 2.5, "abc"])("rejects clinicians = %s", (clinicians) => {
    expect(errorsFor({ ...valid, clinicians }).clinicians).toBe(
      "Clinicians must be between 1 and 1000",
    );
  });

  it("accepts clinicians as a number or a numeric form string", () => {
    expect(PilotSignupSchema.parse({ ...valid, clinicians: 4 }).clinicians).toBe(4);
    expect(PilotSignupSchema.parse({ ...valid, clinicians: "1000" }).clinicians).toBe(1000);
  });

  it("turns empty optional form fields into undefined", () => {
    const r = PilotSignupSchema.parse({ ...valid, centre: "", clinicians: "", note: " ", website: "" });
    expect(r.centre).toBeUndefined();
    expect(r.clinicians).toBeUndefined();
    expect(r.note).toBeUndefined();
    expect(r.website).toBeUndefined();
  });

  it("limits the note to 1000 characters", () => {
    expect(errorsFor({ ...valid, note: "a".repeat(1001) }).note).toBeDefined();
  });
});

describe("honeypot", () => {
  it("is filled when website has text", () => {
    const r = PilotSignupSchema.parse({ ...valid, website: "http://spam" });
    expect(isHoneypotFilled(r)).toBe(true);
  });

  it("is not filled when website is missing or blank", () => {
    expect(isHoneypotFilled(PilotSignupSchema.parse(valid))).toBe(false);
    expect(isHoneypotFilled(PilotSignupSchema.parse({ ...valid, website: "  " }))).toBe(false);
  });
});
