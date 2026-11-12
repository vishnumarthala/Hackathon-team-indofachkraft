import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getIsaaItem, ratingLabel } from "@/lib/isaa";
import {
  collectRedFlags,
  facpBand,
  recommend,
  scoreIsaa,
  type FacpBand,
  type IsaaBand,
  type IsaaScore,
  type RedFlag,
  type Recommendation,
  type ScoringFact,
} from "@/lib/scoring";
import { ReferralSummarySchema, type Brief, type Evidence, type FactValue, type ReferralSummary } from "@/lib/types";

export const KEY_EVIDENCE_LIMIT = 8;
export const INTAKE_HIGHLIGHT_LIMIT = 5;

export const ReferRequestSchema = z.object({
  specialist_name: z
    .string({ error: "Specialist name is required" })
    .trim()
    .min(1, { error: "Specialist name is required" })
    .max(100, { error: "Specialist name must be at most 100 characters" }),
  specialist_email: z
    .string({ error: "Enter a valid email address" })
    .trim()
    .pipe(z.email({ error: "Enter a valid email address" }).max(254, { error: "Enter a valid email address" })),
  reason: z
    .string({ error: "Reason for referral is required" })
    .trim()
    .min(3, { error: "Reason must be at least 3 characters" })
    .max(1000, { error: "Reason must be at most 1000 characters" }),
  // 020 NFR-1: consent is checked server-side (referral_share); a client `parent_consent` flag is ignored.
});
export type ReferRequest = z.infer<typeof ReferRequestSchema>;

export type PacketIsaa = {
  total: number | null;
  minimum_total: number;
  band: IsaaBand | null;
  confirmed: number;
  // Domain scores are sums of confirmed/edited items only.
  by_domain: { domain_id: string; name: string; score: number; max: number }[];
};

export type KeyEvidence = {
  fact_id: string;
  item_id: string;
  item_text: string;
  rating: number;
  quote: string;
  start_sec: number;
  recording_id: string;
  session_number: number | null;
};

export type Decision = { item_id: string; rating: number; status: "confirmed" | "edited"; confirmed_at: string | null };

export type ReferralPacket = {
  generated_at: string;
  child_alias: string;
  child_age_months: number | null;
  isaa: PacketIsaa;
  facp: { score: number | null; band: FacpBand | null };
  red_flags: RedFlag[];
  recommendation: Recommendation;
  key_evidence: KeyEvidence[];
  intake_highlights: string[];
  summary: ReferralSummary;
  therapist: string;
  decisions: Decision[];
};

// Loose shape check for packets read back from the database (written by buildPacket).
const ReferralPacketSchema = z.looseObject({
  generated_at: z.string(),
  child_alias: z.string(),
  child_age_months: z.number().nullable(),
  isaa: z.looseObject({
    total: z.number().nullable(),
    minimum_total: z.number(),
    band: z.string().nullable(),
    confirmed: z.number(),
    by_domain: z.array(z.looseObject({ domain_id: z.string(), name: z.string(), score: z.number(), max: z.number() })),
  }),
  facp: z.looseObject({ score: z.number().nullable(), band: z.string().nullable() }),
  red_flags: z.array(z.looseObject({ type: z.string(), source: z.string() })),
  recommendation: z.looseObject({ referral_recommended: z.boolean(), reasons: z.array(z.string()), action: z.string() }),
  key_evidence: z.array(
    z.looseObject({
      fact_id: z.string(),
      item_id: z.string(),
      item_text: z.string(),
      rating: z.number(),
      quote: z.string(),
      start_sec: z.number(),
      recording_id: z.string(),
      session_number: z.number().nullable(),
    }),
  ),
  intake_highlights: z.array(z.string()),
  summary: ReferralSummarySchema,
  therapist: z.string(),
  decisions: z.array(z.looseObject({ item_id: z.string(), rating: z.number() })),
});

export function parsePacket(value: unknown): ReferralPacket | null {
  const result = ReferralPacketSchema.safeParse(value);
  return result.success ? (result.data as unknown as ReferralPacket) : null;
}

export type PacketFact = {
  id: string;
  item_id: string;
  value: FactValue;
  status: string;
  evidence: Evidence | null;
  confirmed_at: string | null;
};

export type PacketSession = {
  id: string;
  session_number: number | null;
  status: string;
  kind?: string;
  created_at?: string;
};

export type IntakeFlags = { lost_speech?: boolean; self_injury?: boolean };

export type DecidedFact = Omit<PacketFact, "value" | "status"> & { value: number; status: "confirmed" | "edited" };

function isRating(value: FactValue): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Confirmed/edited ISAA facts with a valid rating: the only facts a referral surface may use. */
export function decidedIsaaFacts(facts: PacketFact[]): DecidedFact[] {
  return facts
    .filter(
      (fact) =>
        (fact.status === "confirmed" || fact.status === "edited") &&
        isRating(fact.value) &&
        getIsaaItem(fact.item_id) !== undefined,
    )
    .map((fact) => ({ ...fact, value: fact.value as number, status: fact.status as "confirmed" | "edited" }));
}

/** The latest extracted session: the Referral tab and the refer route both use this one. */
export function pickReferralSession<T extends PacketSession>(recordings: T[]): T | null {
  const sessions = recordings.filter((r) => (r.kind ?? "session") === "session" && r.status === "extracted");
  sessions.sort(
    (a, b) =>
      (b.session_number ?? 0) - (a.session_number ?? 0) || (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
  return sessions[0] ?? null;
}

export function intakeHighlights(brief: Brief | null): string[] {
  return (brief?.parent_reported ?? []).slice(0, INTAKE_HIGHLIGHT_LIMIT).map((row) => `${row.label}: ${row.value}`);
}

export type Assessment = {
  decided: DecidedFact[];
  score: IsaaScore;
  redFlags: RedFlag[];
  recommendation: Recommendation;
};

/** Score, red flags and recommendation from confirmed/edited facts only (no Gemini extraction flags). */
export function assessReferral(input: {
  isaaFacts: PacketFact[];
  facpScore: number | null;
  brief: Brief | null;
  intakeFlags?: IntakeFlags;
}): Assessment {
  const decided = decidedIsaaFacts(input.isaaFacts);
  const scoring: ScoringFact[] = decided.map((f) => ({ item_id: f.item_id, value: f.value, status: f.status }));
  const score = scoreIsaa(scoring);
  const redFlags = collectRedFlags({
    isaaFacts: scoring,
    intake: {
      lost_speech: input.intakeFlags?.lost_speech === true,
      self_injury: input.intakeFlags?.self_injury === true,
      brief_red_flags: input.brief?.red_flags ?? [],
    },
  });
  const recommendation = recommend({ isaa: score, facpScore: input.facpScore, redFlags });
  return { decided, score, redFlags, recommendation };
}

export function packetIsaa(score: IsaaScore): PacketIsaa {
  return {
    total: score.total,
    minimum_total: score.minimum_total,
    band: score.band,
    confirmed: score.confirmed,
    by_domain: score.by_domain.map((d) => ({ domain_id: d.domain_id, name: d.name, score: d.score, max: d.max })),
  };
}

/** Rebuilds the IsaaScore shape formatIsaaScore needs from a stored packet (never with suggested values). */
export function scoreFromPacket(isaa: PacketIsaa): IsaaScore {
  return {
    rated: isaa.confirmed,
    confirmed: isaa.confirmed,
    total: isaa.total,
    minimum_total: isaa.minimum_total,
    suggested_total: isaa.minimum_total,
    band: isaa.band,
    minimum_band: isaa.band ?? "no_autism",
    suggested_band: isaa.band ?? "no_autism",
    by_domain: isaa.by_domain.map((d) => ({ ...d, rated: 0, confirmed: 0 })),
  };
}

export function keyEvidence(decided: DecidedFact[], sessionNumber: number | null): KeyEvidence[] {
  return decided
    .filter((fact) => fact.evidence?.verified === true)
    .sort((a, b) => b.value - a.value || Number(a.item_id) - Number(b.item_id))
    .slice(0, KEY_EVIDENCE_LIMIT)
    .map((fact) => {
      const evidence = fact.evidence as Evidence;
      return {
        fact_id: fact.id,
        item_id: fact.item_id,
        item_text: getIsaaItem(fact.item_id)?.text ?? "",
        rating: fact.value,
        quote: evidence.quote,
        start_sec: evidence.start_sec,
        recording_id: evidence.recording_id,
        session_number: sessionNumber,
      };
    });
}

export type PacketCase = {
  child_alias: string;
  child_age_months: number | null;
  therapist_name: string;
  facp_score: number | null;
};

export type BuildPacketInput = {
  caseRow: PacketCase;
  session: { id: string; session_number: number | null };
  isaaFacts: PacketFact[];
  brief: Brief | null;
  intakeFlags?: IntakeFlags;
  summary: ReferralSummary;
  generatedAt: string;
};

/** Pure: builds the stored referral packet from confirmed/edited facts and an already validated summary. */
export function buildPacket(input: BuildPacketInput): ReferralPacket {
  const { caseRow } = input;
  const { decided, score, redFlags, recommendation } = assessReferral({
    isaaFacts: input.isaaFacts,
    facpScore: caseRow.facp_score,
    brief: input.brief,
    intakeFlags: input.intakeFlags,
  });
  return {
    generated_at: input.generatedAt,
    child_alias: caseRow.child_alias,
    child_age_months: caseRow.child_age_months,
    isaa: packetIsaa(score),
    facp: { score: caseRow.facp_score, band: facpBand(caseRow.facp_score) },
    red_flags: redFlags,
    recommendation,
    key_evidence: keyEvidence(decided, input.session.session_number),
    intake_highlights: intakeHighlights(input.brief),
    summary: input.summary,
    therapist: caseRow.therapist_name,
    decisions: [...decided]
      .sort((a, b) => Number(a.item_id) - Number(b.item_id))
      .map((f) => ({ item_id: f.item_id, rating: f.value, status: f.status, confirmed_at: f.confirmed_at })),
  };
}

export function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function sessionLabel(sessionNumber: number | null, startSec: number): string {
  return `Session ${sessionNumber ?? "?"} · ${formatClock(startSec)}`;
}

const RED_FLAG_NAMES: Record<string, string> = { lost_speech: "Lost speech", self_injury: "Self-injury" };

export function redFlagText(flag: RedFlag): string {
  const name = RED_FLAG_NAMES[flag.type] ?? flag.type;
  if (flag.source === "isaa_item") return `${name} (ISAA item ${flag.item_id}, confirmed by the therapist)`;
  if (flag.source === "intake") {
    return flag.quote ? `${name} (parent-reported at intake): "${flag.quote}"` : `${name} (parent-reported at intake)`;
  }
  return flag.quote ? `${name}: "${flag.quote}"` : name;
}

export function referralSystemPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "referral.md"), "utf8");
}

/** Gemini input: confirmed/edited facts, red flags and parent-reported intake highlights only. */
export function buildSummaryPrompt(input: {
  caseRow: PacketCase;
  assessment: Assessment;
  brief: Brief | null;
  reason: string;
}): string {
  const { caseRow, assessment, brief } = input;
  const facts = [...assessment.decided]
    .sort((a, b) => Number(a.item_id) - Number(b.item_id))
    .map((f) => {
      const quote = f.evidence?.verified ? ` - "${f.evidence.quote}"` : "";
      return `- ${f.item_id}. ${getIsaaItem(f.item_id)?.text ?? ""}: ${ratingLabel(f.value)}${quote}`;
    });
  const age = caseRow.child_age_months != null ? `, ${caseRow.child_age_months} months` : "";
  const lines = [
    `Child: ${caseRow.child_alias}${age}`,
    `Therapist: ${caseRow.therapist_name}`,
    `Therapist's reason for referral: ${input.reason}`,
    "",
    `Confirmed ISAA items (${assessment.decided.length} of 40, confirmed by the therapist):`,
    ...(facts.length ? facts : ["- none"]),
    "",
    "Red flags:",
    ...(assessment.redFlags.length ? assessment.redFlags.map((f) => `- ${redFlagText(f)}`) : ["- none"]),
    "",
    "Intake highlights (parent-reported):",
    ...(brief?.parent_reported.length ? brief.parent_reported.map((row) => `- ${row.label}: ${row.value}`) : ["- none"]),
  ];
  if (brief?.summary) lines.push("", `Intake summary (parent-reported): ${brief.summary}`);
  return lines.join("\n");
}
