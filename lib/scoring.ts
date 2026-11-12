import isaaSchema from "@/schemas/isaa.json";
import facpSchema from "@/schemas/facp.json";

export type IsaaBand = "no_autism" | "mild" | "moderate" | "severe";
export type FacpBand = "typical" | "borderline" | "moderate" | "severe";
export type RedFlagKind = "lost_speech" | "self_injury";
export type RedFlagSource = "isaa_item" | "extraction" | "intake";

export type ScoringFact = { item_id: string; value: number | null; status: string };

export type DomainScore = {
  domain_id: string;
  name: string;
  score: number;
  max: number;
  rated: number;
  confirmed: number;
};

export type IsaaScore = {
  rated: number;
  confirmed: number;
  total: number | null;
  minimum_total: number;
  suggested_total: number;
  band: IsaaBand | null;
  minimum_band: IsaaBand;
  suggested_band: IsaaBand;
  by_domain: DomainScore[];
};

export type RedFlag = {
  type: RedFlagKind;
  source: RedFlagSource;
  item_id?: string;
  quote?: string;
  segment_id?: string;
  turn_id?: string;
};

export type Recommendation = {
  referral_recommended: boolean;
  reasons: string[];
  action: string;
  isaa_band: IsaaBand | null;
  facp_band: FacpBand | null;
  provisional: boolean;
};

// Structural shapes of the extraction and brief red flags (lib/types.ts), so scoring stays dependency-free.
export type ExtractionRedFlagInput = { type: string; segment_id: string; quote: string };
export type BriefRedFlagInput = { type: string; turn_id: string; quote: string };

export type IntakeRedFlagInput = {
  lost_speech?: boolean;
  self_injury?: boolean;
  brief_red_flags?: BriefRedFlagInput[];
};

export const SUGGESTION_LABEL = "Suggested by DoctorNearMe - the therapist decides";

const ITEM_COUNT = 40;
const RED_FLAG_ORDER: RedFlagKind[] = ["lost_speech", "self_injury"];
const RED_FLAG_REASONS: Record<RedFlagKind, string> = {
  lost_speech: "Red flag: lost speech",
  self_injury: "Red flag: self-injury",
};
const REFERRAL_SUFFIX = " + referral to specialist (Phase 3)";

export const ISAA_BAND_LABELS = Object.fromEntries(
  isaaSchema.bands.map((b) => [b.id, b.label]),
) as Record<IsaaBand, string>;

export const FACP_ACTIONS = Object.fromEntries(
  facpSchema.bands.map((b) => [b.id, b.action]),
) as Record<FacpBand, string>;

const RED_FLAG_ITEMS = isaaSchema.red_flag_items as Record<string, RedFlagKind>;

export function isaaBand(total: number): IsaaBand {
  if (total < 70) return "no_autism";
  if (total <= 106) return "mild";
  if (total <= 153) return "moderate";
  return "severe";
}

export function facpBand(score: number | null): FacpBand | null {
  if (score === null) return null;
  if (score >= 80) return "typical";
  if (score >= 60) return "borderline";
  if (score >= 40) return "moderate";
  return "severe";
}

function validRating(value: number | null): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function isDecided(status: string): boolean {
  return status === "confirmed" || status === "edited";
}

function itemsById(facts: ScoringFact[]): Map<number, { value: number | null; decided: boolean }> {
  const items = new Map<number, { value: number | null; decided: boolean }>();
  for (const fact of facts) {
    if (!/^[1-9]\d*$/.test(fact.item_id)) continue;
    const id = Number(fact.item_id);
    if (id > ITEM_COUNT || items.has(id)) continue;
    const value = validRating(fact.value);
    items.set(id, { value, decided: value !== null && isDecided(fact.status) });
  }
  return items;
}

export function scoreIsaa(facts: ScoringFact[]): IsaaScore {
  const items = itemsById(facts);
  let rated = 0;
  let confirmed = 0;
  let minimumTotal = 0;
  let suggestedTotal = 0;

  for (let id = 1; id <= ITEM_COUNT; id++) {
    const item = items.get(id);
    const value = item?.value ?? null;
    if (value !== null) rated++;
    if (item?.decided) confirmed++;
    minimumTotal += item?.decided && value !== null ? value : 1;
    suggestedTotal += value ?? 1;
  }

  const total = confirmed === ITEM_COUNT ? minimumTotal : null;

  const by_domain = isaaSchema.domains.map((domain) => {
    let score = 0;
    let domainRated = 0;
    let domainConfirmed = 0;
    for (const id of domain.items) {
      const item = items.get(id);
      if (!item || item.value === null) continue;
      score += item.value;
      domainRated++;
      if (item.decided) domainConfirmed++;
    }
    return {
      domain_id: domain.id,
      name: domain.name,
      score,
      max: domain.items.length * 5,
      rated: domainRated,
      confirmed: domainConfirmed,
    };
  });

  return {
    rated,
    confirmed,
    total,
    minimum_total: minimumTotal,
    suggested_total: suggestedTotal,
    band: total === null ? null : isaaBand(total),
    minimum_band: isaaBand(minimumTotal),
    suggested_band: isaaBand(suggestedTotal),
    by_domain,
  };
}

function isRedFlagKind(type: string): type is RedFlagKind {
  return type === "lost_speech" || type === "self_injury";
}

export function collectRedFlags(input: {
  isaaFacts?: ScoringFact[];
  extractionRedFlags?: ExtractionRedFlagInput[];
  intake?: IntakeRedFlagInput;
}): RedFlag[] {
  const candidates: RedFlag[] = [];

  for (const fact of input.isaaFacts ?? []) {
    const type = RED_FLAG_ITEMS[fact.item_id];
    const value = validRating(fact.value);
    if (type && value !== null && value >= 2) {
      candidates.push({ type, source: "isaa_item", item_id: fact.item_id });
    }
  }

  for (const flag of input.extractionRedFlags ?? []) {
    if (isRedFlagKind(flag.type)) {
      candidates.push({ type: flag.type, source: "extraction", quote: flag.quote, segment_id: flag.segment_id });
    }
  }

  for (const flag of input.intake?.brief_red_flags ?? []) {
    if (isRedFlagKind(flag.type)) {
      candidates.push({ type: flag.type, source: "intake", quote: flag.quote, turn_id: flag.turn_id });
    }
  }

  for (const type of RED_FLAG_ORDER) {
    if (input.intake?.[type] === true) candidates.push({ type, source: "intake" });
  }

  return RED_FLAG_ORDER.flatMap((type) => {
    const first = candidates.find((flag) => flag.type === type);
    return first ? [first] : [];
  });
}

export function recommend(input: {
  isaa: IsaaScore;
  facpScore: number | null;
  redFlags: RedFlag[];
}): Recommendation {
  const { isaa, facpScore, redFlags } = input;
  const provisional = isaa.total === null;
  const isaaValue = isaa.total ?? isaa.minimum_total;
  const facp_band = facpBand(facpScore);
  const reasons: string[] = [];

  if (isaaValue >= 70) {
    reasons.push(
      provisional ? `ISAA total at least ${isaaValue} is 70 or more` : `ISAA total ${isaaValue} is 70 or more`,
    );
  }
  for (const type of RED_FLAG_ORDER) {
    if (redFlags.some((flag) => flag.type === type)) reasons.push(RED_FLAG_REASONS[type]);
  }
  if (facp_band === "severe") reasons.push(`FACP score ${facpScore} is below 40`);

  const referral_recommended = reasons.length > 0;

  let action: string;
  if (facp_band) {
    action = FACP_ACTIONS[facp_band] + (referral_recommended && facp_band !== "severe" ? REFERRAL_SUFFIX : "");
  } else if (referral_recommended) {
    action = "Referral to specialist (Phase 3)";
  } else {
    action = "Enter the FACP score to get a suggested action";
  }

  const isaa_band = provisional ? (isaa.minimum_total >= 70 ? isaa.minimum_band : null) : isaa.band;

  return { referral_recommended, reasons, action, isaa_band, facp_band, provisional };
}

export function formatIsaaScore(score: IsaaScore, options: { showSuggested?: boolean } = {}): string {
  if (score.total !== null && score.band !== null) {
    return `ISAA total: ${score.total} · ${ISAA_BAND_LABELS[score.band]}`;
  }
  const suggested = options.showSuggested ? `; AI-suggested total ${score.suggested_total}` : "";
  return `ISAA total: at least ${score.minimum_total} (provisional - ${score.confirmed} of ${ITEM_COUNT} confirmed${suggested})`;
}
