import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { isTabActive } from "@/components/case/CaseTabs";
import { ageLabel, formatDate, formatDateTime, languageName, statusLabel, NEXT_STEPS } from "@/lib/cases/format";
import { caseCreateSchema, caseUpdateSchema, changedFields, hasUpdates, isUuid } from "@/lib/cases/validation";

// Same mapping as lib/http.parseJson: first message per top-level field, root issues under "body".
function fieldErrors(schema: z.ZodType, body: unknown): Record<string, string> | null {
  const result = schema.safeParse(body);
  if (result.success) return null;
  const out: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "body";
    out[key] ??= issue.message;
  }
  return out;
}

const valid = { child_alias: "t1-ravi", parent_alias: "t1-lakshmi", language: "te" };

describe("caseCreateSchema", () => {
  it("accepts a minimal case and fills defaults", () => {
    expect(caseCreateSchema.parse({ child_alias: " t1-ravi ", parent_alias: "p" })).toEqual({
      child_alias: "t1-ravi",
      parent_alias: "p",
      language: "en",
      therapist_name: "Demo Therapist",
    });
  });

  it("returns every FR-3 message for the eval body", () => {
    expect(
      fieldErrors(caseCreateSchema, {
        child_alias: "",
        child_age_months: 5,
        parent_alias: "x",
        parent_email: "nope",
        language: "fr",
      }),
    ).toEqual({
      child_alias: "Child alias is required",
      child_age_months: "Age must be between 12 and 216 months",
      parent_email: "Enter a valid email",
      language: "Choose English, Hindi or Telugu",
    });
  });

  it("treats whitespace-only strings as not given", () => {
    expect(fieldErrors(caseCreateSchema, { child_alias: "   ", parent_alias: "\t" })).toEqual({
      child_alias: "Child alias is required",
      parent_alias: "Parent alias is required",
    });
    const parsed = caseCreateSchema.parse({ ...valid, parent_email: "  ", parent_phone: " ", child_age_months: "", therapist_name: " " });
    expect(parsed).toEqual({ ...valid, therapist_name: "Demo Therapist" });
  });

  it("enforces the 60-character limits", () => {
    const long = "x".repeat(61);
    expect(fieldErrors(caseCreateSchema, { child_alias: long, parent_alias: long, therapist_name: long })).toEqual({
      child_alias: "Child alias must be at most 60 characters",
      parent_alias: "Parent alias must be at most 60 characters",
      therapist_name: "Therapist name must be at most 60 characters",
    });
    expect(caseCreateSchema.parse({ ...valid, child_alias: "x".repeat(60) }).child_alias).toHaveLength(60);
  });

  it("checks age bounds and integers", () => {
    for (const age of [11, 217, 40.5, "abc"]) {
      expect(fieldErrors(caseCreateSchema, { ...valid, child_age_months: age })).toEqual({
        child_age_months: "Age must be between 12 and 216 months",
      });
    }
    expect(caseCreateSchema.parse({ ...valid, child_age_months: 12 }).child_age_months).toBe(12);
    expect(caseCreateSchema.parse({ ...valid, child_age_months: "216" }).child_age_months).toBe(216);
  });

  it("checks the phone pattern", () => {
    for (const phone of ["+49 151 0000000", "9876543210", "1234567"]) {
      expect(caseCreateSchema.parse({ ...valid, parent_phone: phone }).parent_phone).toBe(phone);
    }
    for (const phone of ["123456", "+49-151-000", "phone", "1".repeat(21), "++4915100000"]) {
      expect(fieldErrors(caseCreateSchema, { ...valid, parent_phone: phone })).toEqual({
        parent_phone: "Enter a valid phone number",
      });
    }
  });

  it("rejects a body that is not an object", () => {
    expect(fieldErrors(caseCreateSchema, ["x"])).toHaveProperty("body");
  });
});

describe("caseUpdateSchema", () => {
  it("validates the FACP score", () => {
    for (const score of [-1, 101, 55.5, "abc"]) {
      expect(fieldErrors(caseUpdateSchema, { facp_score: score })).toEqual({
        facp_score: "FACP score must be between 0 and 100",
      });
    }
    expect(caseUpdateSchema.parse({ facp_score: 0 })).toEqual({ facp_score: 0 });
    expect(caseUpdateSchema.parse({ facp_score: "100" })).toEqual({ facp_score: 100 });
    expect(caseUpdateSchema.parse({ facp_score: null })).toEqual({ facp_score: null });
  });

  it("clears parent email and phone with an empty string or null", () => {
    expect(caseUpdateSchema.parse({ parent_email: "", parent_phone: "  " })).toEqual({
      parent_email: null,
      parent_phone: null,
    });
    expect(caseUpdateSchema.parse({ parent_email: null })).toEqual({ parent_email: null });
  });

  it("applies the create rules to email, phone and language", () => {
    expect(fieldErrors(caseUpdateSchema, { parent_email: "nope", parent_phone: "x", language: "" })).toEqual({
      parent_email: "Enter a valid email",
      parent_phone: "Enter a valid phone number",
      language: "Choose English, Hindi or Telugu",
    });
  });

  it("detects an empty update and ignores unknown keys", () => {
    expect(hasUpdates(caseUpdateSchema.parse({}))).toBe(false);
    expect(hasUpdates(caseUpdateSchema.parse({ child_alias: "x", status: "referred" }))).toBe(false);
    expect(hasUpdates(caseUpdateSchema.parse({ parent_email: "" }))).toBe(true);
  });

  it("lists only fields whose value changed", () => {
    const current = { facp_score: 55, language: "te", parent_email: null, parent_phone: "+49 151 0000000" };
    expect(changedFields(current, caseUpdateSchema.parse({ facp_score: 55, language: "hi", parent_email: "" }))).toEqual([
      "language",
    ]);
    expect(changedFields(current, caseUpdateSchema.parse({ parent_phone: "", parent_email: "a@b.co" }))).toEqual([
      "parent_email",
      "parent_phone",
    ]);
  });
});

describe("helpers", () => {
  it("recognises uuids", () => {
    expect(isUuid("00000000-0000-4000-8000-00000000ffff")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });

  it("formats labels and dates in the viewer's time zone (default Asia/Kolkata)", () => {
    expect([languageName("en"), languageName("hi"), languageName("te")]).toEqual(["English", "Hindi", "Telugu"]);
    expect([statusLabel("booked"), statusLabel("intake_done"), statusLabel("in_assessment"), statusLabel("referred")]).toEqual([
      "Booked",
      "Intake done",
      "In assessment",
      "Referred",
    ]);
    expect([ageLabel(40), ageLabel(null)]).toEqual(["40 months", "-"]);
    expect(formatDateTime("2026-11-07T11:05:00Z")).toBe("2026-11-07 16:35 IST");
    expect(formatDateTime("2026-11-07T11:05:00Z", "Europe/Berlin")).toBe("2026-11-07 12:05 GMT+1");
    expect(formatDateTime("2026-07-01T22:30:00Z", "Europe/Berlin")).toBe("2026-07-02 00:30 GMT+2");
    expect(formatDate("2026-11-07T19:30:00Z")).toBe("2026-11-08");
    expect(formatDate("2026-11-07T19:30:00Z", "Europe/Berlin")).toBe("2026-11-07");
    expect(NEXT_STEPS.booked).toBe("Send the parent an intake link from the Brief tab.");
  });

  it("highlights Overview only on the case root and other tabs on sub-paths", () => {
    const base = "/cases/abc";
    expect(isTabActive("/cases/abc", base, "")).toBe(true);
    expect(isTabActive("/cases/abc/", base, "")).toBe(true);
    expect(isTabActive("/cases/abc/sessions", base, "")).toBe(false);
    expect(isTabActive("/cases/abc/sessions/new", base, "sessions")).toBe(true);
    expect(isTabActive("/cases/abc/sessions/123", base, "sessions")).toBe(true);
    expect(isTabActive("/cases/abc/sessionsx", base, "sessions")).toBe(false);
    expect(isTabActive("/cases/abc/report", base, "referral")).toBe(false);
  });
});
