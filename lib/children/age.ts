// Ticket 020: age label (pure, shared by server pages).
import type { TFunction } from "@/lib/i18n/keys";
import { ageParts } from "./codes";

export function ageLabel(t: TFunction<"family.children">, dateOfBirth: string | null, today: Date = new Date()): string {
  const parts = dateOfBirth ? ageParts(dateOfBirth, today) : null;
  if (!parts) return t("ageUnknown");
  return t("age", { years: t("years", { count: parts.years }), months: t("months", { count: parts.months }) });
}
