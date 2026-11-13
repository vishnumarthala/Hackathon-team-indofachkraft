// Ticket 035 D-4: which pre-consult intake a new service gets by default (the provider can change it per service).
// Child Development agent (en/hi/te) for developmental and therapy professions; the generic English agent for
// physiotherapists and paediatricians. Pure; safe in client and server code.
import type { ProviderType } from "@/lib/providers/constants";

export type IntakeKind = "child_dev" | "generic" | "none";

const GENERIC: readonly string[] = ["physiotherapist", "pediatrician"];

export function defaultIntakeKind(providerType: ProviderType | string | null | undefined): IntakeKind {
  if (!providerType) return "none";
  return GENERIC.includes(providerType) ? "generic" : "child_dev";
}
