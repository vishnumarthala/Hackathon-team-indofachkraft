// Shared free-text red-flag classifier (ticket 040 FR-3). The developmental check-in (033) asks one yes/no question
// per red flag (RED_FLAG_CODES in lib/clinical/checkin.ts); free text (follow-up questions, agent transcripts) is
// matched here against the same codes plus the follow-up agent's extra emergencies. A match bypasses every model
// and answers only the 108/112 message (lib/screen/questions.ts URGENT_MESSAGE). Pure, safe in the browser.
// Deliberately broad: a false positive costs one safety message; a miss could cost a life.
import { RED_FLAG_CODES, type RedFlagCode } from "@/lib/clinical/checkin";

export const EXTRA_RED_FLAG_CODES = ["medicine_overdose", "unconscious", "suicidal"] as const;
export const TEXT_RED_FLAG_CODES = [...RED_FLAG_CODES, ...EXTRA_RED_FLAG_CODES] as const;
export type TextRedFlagCode = RedFlagCode | (typeof EXTRA_RED_FLAG_CODES)[number];

const PERSON = "(?:him|her|them|my|your|it)";

const PATTERNS: Record<TextRedFlagCode, RegExp[]> = {
  // Checked first: the most time-critical emergencies.
  breathing: [
    /\b(?:not|isn'?t|is not|stopped|stop|can'?t|cannot|can not|unable to|struggling to|trouble|difficulty|hard to)\s+(?:\w+\s+){0,2}breath/,
    /\bbreathing\s+(?:problem|trouble|difficult|fast|hard|badly|heavily|noisily|strange)/,
    /\b(?:breathless|short of breath|gasping|wheez|chok(?:e|ed|es|ing))/,
    /\b(?:turn(?:s|ed|ing)?|going|gone|went|look(?:s|ing)?)\s+blue\b/,
    /\bblue\s+(?:lips|around the (?:lips|mouth))/,
  ],
  unconscious: [
    /\b(?:unconscious|unresponsive|passed out|fainted|faint(?:s|ing)\b|collapsed|blacked out)/,
    /\b(?:not|isn'?t|stopped)\s+(?:responding|waking|reacting)/,
    /\b(?:won'?t|will not|can'?t|cannot|can not|doesn'?t|does not)\s+wake/,
  ],
  seizure: [/\b(?:seizure|convuls|epilep|fits\b|jerking|twitching all over)/, /\b(?:having|had|has|in)\s+a\s+fit\b/],
  medicine_overdose: [
    /\boverdos/,
    /\bpoison/,
    /\btoo\s+(?:much|many)\s+(?:of\s+)?(?:the\s+|his\s+|her\s+|my\s+)?(?:medicine|medication|meds|syrup|tablets?|pills?|drops|capsules?|dose)/,
    /\b(?:swallowed|drank|ate|took|taken|eaten)\s+(?:a\s+|the\s+|all\s+(?:the\s+|of\s+(?:the|his|her|my)\s+)?|half\s+(?:a|the)\s+|many\s+|several\s+|extra\s+|his\s+|her\s+|my\s+)?(?:whole\s+|entire\s+)?(?:bottle|strip|packet|pills|tablets|capsules|medicine bottle)/,
    /\b(?:accidentally|by mistake|by accident)\b.*\b(?:gave|given|took|taken|swallowed|drank|double|extra|twice)/,
    /\b(?:gave|given|took|taken|swallowed|drank)\b.*\b(?:by mistake|accidentally|by accident)/,
  ],
  suicidal: [
    /\bsuicid/,
    new RegExp(`\\b(?:kill|kills|killing|end|ends|ending)\\s+${PERSON}\\s*(?:self|selves|life)`),
    /\bwants?\s+to\s+die\b|\bwish(?:es)?\s+(?:he|she|they)\s+(?:was|were)\s+dead\b/,
  ],
  self_injury: [
    /\bself[-\s]?(?:harm|injur)/,
    /\b(?:hurt|hurts|hurting|harm|harms|harming|cut|cuts|cutting|bit|bites|biting|hit|hits|hitting)\s+(?:him|her|them)\s*sel(?:f|ves)/,
    /\b(?:bang|bangs|banging|hit|hits|hitting)\s+(?:his|her|their)\s+head/,
    /\bhead[-\s]?bang/,
  ],
  safety_concern: [
    /\b(?:someone|somebody|he|she|they|an adult|a relative|a teacher)\s+(?:is\s+|are\s+|was\s+|keeps\s+)?(?:hurting|abusing|beating|touching)\s+(?:him|her|them|my)/,
    /\b(?:abuse|abused|abusing|in danger|unsafe at home|not safe at home|emergency)\b/,
  ],
  // Picky eating ("not eating vegetables") is a plan question, not a red flag: only stopping food AND drink, all
  // food, or weight loss / dehydration count.
  not_eating_drinking: [
    /\b(?:stopped|stops|has stopped)\s+(?:eating|drinking)/,
    /\b(?:not|isn'?t|won'?t|will not|refus(?:es|ed|ing) to)\s+(?:eat(?:ing)?|drink(?:ing)?)\s+(?:or|and|nor)\s+(?:drink|eat)/,
    /\b(?:not|isn'?t|won'?t|will not)\s+(?:eat(?:ing)?|drink(?:ing)?)\s+anything/,
    /\b(?:not|isn'?t|won'?t|will not)\s+drink(?:ing)?\s+(?:any\s+)?(?:water|fluids|milk)/,
    /\b(?:losing weight|lost weight|dehydrat|no urine|not peeing)/,
  ],
  // Losing skills the child had (033 rf_skill_regression); "not talking much yet" is a plan question.
  skill_regression: [
    /\b(?:stopped|stops|has stopped|no longer)\s+(?:\w+\s+){0,1}(?:talking|speaking|using (?:words|skills)|walking|saying (?:words|anything)|talks|speaks|walks)\b/,
    /\b(?:lost|losing|loses)\s+(?:\w+\s+){0,2}(?:words|speech|skills|ability)/,
    /\bregress/,
  ],
};

const ORDER: TextRedFlagCode[] = [
  "breathing",
  "unconscious",
  "seizure",
  "medicine_overdose",
  "suicidal",
  "self_injury",
  "safety_concern",
  "not_eating_drinking",
  "skill_regression",
];

/** Lower-cased, curly quotes straightened, whitespace collapsed. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The first red flag a free-text message describes, or null. */
export function classifyRedFlagText(text: string): TextRedFlagCode | null {
  const t = normalizeText(text);
  for (const code of ORDER) if (PATTERNS[code].some((re) => re.test(t))) return code;
  return null;
}
