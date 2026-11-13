// Ticket 018 FR-2/FR-11: catalogue parity, placeholders, plural pairs, copy rules and the review list.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { CONSENT_LABEL, MESSAGES } from "@/components/intake/IntakeCall";
import { SIMULATE_DONE, SIMULATE_FAILED, SIMULATE_LABEL } from "@/components/intake/SimulateCallButton";
import { DEMO_CONSENT, LIVE_MESSAGES } from "@/components/landing/VoiceDemo";
import { flattenMessages, parseReviewTable, REVIEW_STATUSES } from "@/lib/i18n/review";
import { MSG } from "@/lib/pilots";

const flat = { en: flattenMessages(en), hi: flattenMessages(hi), te: flattenMessages(te) };
const enKeys = Object.keys(flat.en).sort();
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// The only keys allowed to mention "diagnosis" (always as "not a diagnosis").
const NOT_A_DIAGNOSIS_KEYS = enKeys.filter((k) => /not a diagnosis/i.test(flat.en[k]));
const NOT_A_DIAGNOSIS = { hi: "निदान नहीं", te: "నిర్ధారణ కాదు" } as const;
const DIAGNOSIS_TERMS = { hi: /निदान/, te: /నిర్ధారణ/ } as const;

describe("catalogue parity", () => {
  it.each(["hi", "te"] as const)("%s has exactly the en keys", (locale) => {
    expect(Object.keys(flat[locale]).sort()).toEqual(enKeys);
  });

  it.each(["hi", "te"] as const)("%s uses the same {placeholders} as en for every key", (locale) => {
    for (const key of enKeys) expect(placeholders(flat[locale][key]), key).toEqual(placeholders(flat.en[key]));
  });

  it("every value is a non-empty string", () => {
    for (const locale of ["en", "hi", "te"] as const) {
      for (const [key, value] of Object.entries(flat[locale])) expect(value.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  it("plural keys come in complete _one / _other pairs that use {count}", () => {
    const plural = enKeys.filter((k) => /_(zero|one|two|few|many|other)$/.test(k));
    expect(plural.length).toBeGreaterThan(0);
    for (const key of plural) {
      const base = key.replace(/_(zero|one|two|few|many|other)$/, "");
      expect(enKeys, key).toContain(`${base}_one`);
      expect(enKeys, key).toContain(`${base}_other`);
      expect(placeholders(flat.en[key]), key).toContain("count");
    }
  });

  it("product and engine names are never translated", () => {
    for (const key of enKeys) {
      for (const name of ["DoctorNearMe", "CareThread", "ISAA"]) {
        const count = (s: string) => s.split(name).length - 1;
        if (count(flat.en[key]) === 0) continue;
        expect(count(flat.hi[key]), `hi:${key} keeps ${name}`).toBe(count(flat.en[key]));
        expect(count(flat.te[key]), `te:${key} keeps ${name}`).toBe(count(flat.en[key]));
      }
    }
  });
});

describe("copy rules (FR-11)", () => {
  it("en: no 'diagnos' except 'not a diagnosis', never HIPAA", () => {
    expect(NOT_A_DIAGNOSIS_KEYS.length).toBeGreaterThan(0);
    for (const key of enKeys) {
      const value = flat.en[key];
      expect(value.replace(/not a diagnosis/gi, ""), key).not.toMatch(/diagnos/i);
      expect(value, key).not.toMatch(/HIPAA/i);
    }
  });

  it.each(["hi", "te"] as const)("%s: the diagnosis term only appears as 'not a diagnosis' in those keys", (locale) => {
    for (const key of enKeys) {
      const value = flat[locale][key];
      expect(value, `${locale}:${key}`).not.toMatch(/HIPAA/i);
      if (NOT_A_DIAGNOSIS_KEYS.includes(key)) {
        expect(value, `${locale}:${key}`).toContain(NOT_A_DIAGNOSIS[locale]);
        expect(value.split(NOT_A_DIAGNOSIS[locale]).join(""), `${locale}:${key}`).not.toMatch(DIAGNOSIS_TERMS[locale]);
      } else {
        expect(value, `${locale}:${key}`).not.toMatch(DIAGNOSIS_TERMS[locale]);
      }
    }
  });
});

describe("review list (messages/REVIEW.md)", () => {
  const rows = parseReviewTable(readFileSync(path.join(process.cwd(), "messages", "REVIEW.md"), "utf8"));
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it("lists every key once, with the current hi/te text and a valid status", () => {
    expect(rows.map((r) => r.key).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      const row = byKey.get(key)!;
      expect(row.en, key).toBe(flat.en[key]);
      expect(row.hi, `${key}: rerun npx tsx scripts/i18n-review.ts`).toBe(flat.hi[key]);
      expect(row.te, `${key}: rerun npx tsx scripts/i18n-review.ts`).toBe(flat.te[key]);
      expect(REVIEW_STATUSES, key).toContain(row.status);
    }
  });
});

describe("English defaults in client modules match en.json", () => {
  it("intake call messages", () => {
    expect(MESSAGES).toEqual(en.intake.status);
    expect(CONSENT_LABEL).toBe(en.intake.consent);
    expect([SIMULATE_LABEL, SIMULATE_DONE, SIMULATE_FAILED]).toEqual([
      en.intake.simulate.label,
      en.intake.simulate.done,
      en.intake.simulate.failed,
    ]);
  });

  it("voice demo messages", () => {
    const { mic, busy, unavailable, failed, connecting, speaking, listening, ended, quota, paused, notAllowed, concurrent, silence } = en.landing.demo;
    expect(LIVE_MESSAGES).toEqual({ mic, busy, unavailable, failed, connecting, speaking, listening, ended, quota, paused, notAllowed, concurrent, silence });
    expect(DEMO_CONSENT).toBe(en.landing.demo.consent);
  });

  it("pilot sign-up validation messages", () => {
    const e = en.bookDemo.errors;
    expect(MSG).toEqual({
      name: e.name,
      nameMax: e.nameMax.replace("{max}", "100"),
      email: e.email,
      role: e.role,
      country: e.country,
      countryMax: e.countryMax.replace("{max}", "60"),
      centreMax: e.centreMax.replace("{max}", "100"),
      clinicians: e.clinicians,
      noteMax: e.noteMax.replace("{max}", "1000"),
    });
  });
});
