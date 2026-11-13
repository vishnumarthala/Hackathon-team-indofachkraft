// Ticket 039 FR-2/FR-3: prescription item schema, request bodies, messages and the allergy check. Pure, safe in the
// browser (the editor uses the same rules as the server).
import { z } from "zod";
import { RX_FORMS } from "@/lib/scribe/schema";

export { RX_FORMS };
export type RxForm = (typeof RX_FORMS)[number];

export const MAX_ITEMS = 15;
export const RX_STATUSES = ["draft", "signed", "void"] as const;
export type RxStatus = (typeof RX_STATUSES)[number];

const text = (max: number) => z.string().trim().max(max);

/** FR-2 item. Drafts may leave dose/frequency/route empty; signing requires them (`signIssues`). */
export const RxItemSchema = z
  .object({
    drug: z.string().trim().min(1, "Enter the generic name").max(120),
    strength: text(60).default(""),
    form: z.enum(RX_FORMS),
    dose: text(60).default(""),
    frequency: text(60).default(""),
    duration_days: z.number().int().min(1).max(365),
    route: text(40).default(""),
    instructions: text(300)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .strict();
export type RxItem = z.output<typeof RxItemSchema>;

const nullableText = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const RxCreateSchema = z.object({ from_report_id: z.uuid().optional() }).strict();

export const RxPatchSchema = z
  .object({
    items: z.array(RxItemSchema).max(MAX_ITEMS, `At most ${MAX_ITEMS} medicines`),
    advice: nullableText(2000),
    follow_up: nullableText(300),
    version: z.number().int().min(1),
  })
  .strict();
export type RxPatch = z.output<typeof RxPatchSchema>;

export const RxSignSchema = z
  .object({
    confirm: z.literal(true, { error: "Confirm that you reviewed every item" }),
    allergy_override_reason: nullableText(500),
  })
  .strict();

export const RxVoidSchema = z.object({ reason: z.string().trim().min(1, "Give a reason").max(500) }).strict();

export const CONFIRM_TEXT = "I have reviewed every item and take responsibility for this prescription.";

export const MSG = {
  notPrescriber: "Only verified prescribers can write prescriptions",
  notFound: "Prescription not found",
  draftNotFound: "Prescription draft not found",
  stale: "This prescription was changed by someone else. Reload to see the latest version.",
  signedReadOnly: "Signed prescriptions cannot be changed",
  alreadySigned: "This prescription is already signed",
  notSigned: "Only a signed prescription can be cancelled",
  noItems: "Add at least one medicine before signing",
  incomplete: "Complete every medicine before signing",
  allergyMatch: "A medicine matches a recorded allergy. Give a reason to prescribe it anyway.",
  noRegistration: "Your prescriber profile has no registration number",
} as const;

/** Fields a signed item must have (FR-2): drug, dose, frequency, duration, route. Keys like `items.0.dose`. */
export function signIssues(items: RxItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  items.forEach((item, i) => {
    if (!item.drug.trim()) out[`items.${i}.drug`] = "Enter the generic name";
    if (!item.dose.trim()) out[`items.${i}.dose`] = "Enter the dose";
    if (!item.frequency.trim()) out[`items.${i}.frequency`] = "Enter how often";
    if (!item.route.trim()) out[`items.${i}.route`] = "Enter the route";
  });
  return out;
}

export type AllergyMatch = { item_index: number; drug: string; substance: string; severity: string };

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * FR-4: item drug names against the child's recorded allergies (021). A match when, after normalising case and
 * punctuation, either name contains the other as whole words ("Synthetic-drug-X" ~ "synthetic drug x 5 mg"). No drug
 * database (out of scope): related drugs (e.g. penicillin -> amoxicillin) are not detected.
 */
export function allergyMatches(items: Pick<RxItem, "drug">[], allergies: { substance: string; severity?: string }[]): AllergyMatch[] {
  const out: AllergyMatch[] = [];
  items.forEach((item, i) => {
    const drug = normalise(item.drug);
    if (!drug) return;
    for (const allergy of allergies) {
      const substance = normalise(allergy.substance);
      if (!substance) continue;
      if (` ${drug} `.includes(` ${substance} `) || ` ${substance} `.includes(` ${drug} `)) {
        out.push({ item_index: i, drug: item.drug, substance: allergy.substance, severity: allergy.severity ?? "unknown" });
      }
    }
  });
  return out;
}

/** An empty draft item for the editor. */
export function blankItem(): RxItem {
  return { drug: "", strength: "", form: "tablet", dose: "", frequency: "", duration_days: 5, route: "oral", instructions: null };
}
