// Ticket 048 FR-3: M-CHAT-R/F (MCHAT_RF) for 18-30 months, behind the MCHAT_LICENSED flag (default off). Pure, safe
// in the browser. The scoring is the published algorithm: one point per item answered with its risk answer ("yes"
// for items 2, 5 and 12, "no" for the rest); 0-2 low, 3-7 moderate (offer the Follow-Up), 8-20 high (refer straight
// away). Follow-Up: only the items that scored are followed up; 2 or more still failing = positive, 0-1 = negative.
// The item and Follow-Up wording in schemas/mchat-rf.json are PLACEHOLDERS until the licence for commercial digital
// use is confirmed (rd.md open question); load the licensed text and the licence reference before turning it on.
import mchatJson from "@/schemas/mchat-rf.json";

export const MCHAT_ANSWERS = ["yes", "no"] as const;
export type MchatAnswer = (typeof MCHAT_ANSWERS)[number];
export const MCHAT_FOLLOW_UP_ANSWERS = ["pass", "fail"] as const;
export type MchatFollowUpAnswer = (typeof MCHAT_FOLLOW_UP_ANSWERS)[number];

export const MCHAT_RISKS = ["low", "moderate", "high"] as const;
export type MchatRisk = (typeof MCHAT_RISKS)[number];
export type MchatFollowUpResult = "negative" | "positive";

export type MchatItem = { id: string; number: number; text_en: string; risk_answer: MchatAnswer };
export type MchatFollowUpItem = { id: string; item: string; text_en: string };

export type MchatDefinition = {
  instrument: "MCHAT_RF";
  version: string;
  title: string;
  status: string;
  licence: { status: string; reference: string | null; copyright: string; contact: string; note: string };
  age_months: { min: number; max: number };
  answer_scale: MchatAnswer[];
  items: MchatItem[];
  scoring: {
    rule: string;
    max_total: number;
    bands: { id: MchatRisk; min: number; max: number }[];
    follow_up_for: MchatRisk;
    rescreen_under_months: number;
  };
  follow_up: {
    optional: boolean;
    administered_for: MchatRisk;
    description: string;
    answer_scale: MchatFollowUpAnswer[];
    items: MchatFollowUpItem[];
    positive_min: number;
  };
  result_copy: Record<MchatRisk | "follow_up_negative" | "follow_up_positive", string>;
};

export const MCHAT = mchatJson as MchatDefinition;
export const MCHAT_ITEM_IDS: string[] = MCHAT.items.map((i) => i.id);

/** True while the item text is the placeholder (no licensed wording loaded yet). */
export const MCHAT_TEXT_IS_PLACEHOLDER = MCHAT.status === "placeholder_text_pending_licence";

export const isMchatAnswer = (value: unknown): value is MchatAnswer =>
  typeof value === "string" && (MCHAT_ANSWERS as readonly string[]).includes(value);
export const isMchatFollowUpAnswer = (value: unknown): value is MchatFollowUpAnswer =>
  typeof value === "string" && (MCHAT_FOLLOW_UP_ANSWERS as readonly string[]).includes(value);

export function riskForTotal(total: number): MchatRisk {
  const band = MCHAT.scoring.bands.find((b) => total >= b.min && total <= b.max);
  if (!band) throw new Error(`M-CHAT-R total out of range: ${total}`);
  return band.id;
}

export type MchatScore = {
  instrument: "MCHAT_RF";
  version: string;
  complete: boolean;
  answered: number;
  total: number;
  max_total: number;
  /** null until all 20 items are answered. */
  risk: MchatRisk | null;
  /** Items that scored a point (the ones the Follow-Up re-asks), in item order. */
  at_risk_items: string[];
  /** Follow-Up: offered for a moderate result only; `result` once every at-risk item has a pass/fail. */
  follow_up: { offered: boolean; answered: number; failed: number; result: MchatFollowUpResult | null };
  result_text: string | null;
};

/** Scores a (possibly partial) answer set `{ mchat_N: yes|no, mchatfu_N: pass|fail }`. */
export function scoreMchat(answers: Record<string, unknown>): MchatScore {
  let total = 0;
  let answered = 0;
  const atRisk: string[] = [];
  for (const item of MCHAT.items) {
    const answer = answers[item.id];
    if (!isMchatAnswer(answer)) continue;
    answered += 1;
    if (answer === item.risk_answer) {
      total += 1;
      atRisk.push(item.id);
    }
  }
  const complete = answered === MCHAT.items.length;
  const risk = complete ? riskForTotal(total) : null;
  const offered = risk === MCHAT.follow_up.administered_for;
  const fu = offered ? followUpIdsFor(atRisk) : [];
  const fuAnswers = fu.map((id) => answers[id]).filter(isMchatFollowUpAnswer);
  const failed = fuAnswers.filter((a) => a === "fail").length;
  const fuResult: MchatFollowUpResult | null =
    offered && fuAnswers.length === fu.length ? (failed >= MCHAT.follow_up.positive_min ? "positive" : "negative") : null;
  const copyKey = fuResult ? (fuResult === "positive" ? "follow_up_positive" : "follow_up_negative") : risk;
  return {
    instrument: "MCHAT_RF",
    version: MCHAT.version,
    complete,
    answered,
    total,
    max_total: MCHAT.scoring.max_total,
    risk,
    at_risk_items: atRisk,
    follow_up: { offered, answered: fuAnswers.length, failed, result: fuResult },
    result_text: copyKey ? MCHAT.result_copy[copyKey] : null,
  };
}

/** Follow-Up item ids for the items that scored (`mchat_3` -> `mchatfu_3`). */
export function followUpIdsFor(itemIds: string[]): string[] {
  return itemIds.map((id) => MCHAT.follow_up.items.find((f) => f.item === id)?.id).filter((id): id is string => Boolean(id));
}

export function isMchatItemId(id: string): boolean {
  return MCHAT_ITEM_IDS.includes(id);
}

export function isMchatFollowUpId(id: string): boolean {
  return MCHAT.follow_up.items.some((f) => f.id === id);
}
