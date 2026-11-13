// Ticket 021: the `health_profile` share scope (022 registry). The health profile belongs to the child (kept by
// the guardian), not to an organisation, so a grant from any source org shows the one current profile. The
// grantee org can already read it through its own case (021 FR-5); the loader makes the shared-records view
// show it instead of "not available yet". Never history, never drafts.
import { isUuid } from "@/lib/cases/validation";
import { ENGLISH_HEALTH_LABELS, healthProfileMarkdown, type HealthMarkdownLabels } from "@/lib/health/summary";
import { getHealthProfile } from "@/lib/queries/health";
import type { ShareLoader, SharedItem } from "@/lib/sharing/registry";

const TITLE = "Health profile";

/** Translated labels inside a request; English when there is no request (scripts, tests). */
async function labels(): Promise<{ title: string; labels: HealthMarkdownLabels }> {
  try {
    const { getT } = await import("@/lib/i18n/server");
    const [t, ts, tsev, tf] = await Promise.all([getT("health"), getT("health.sections"), getT("health.severity"), getT("health.fields")]);
    return {
      title: t("title"),
      labels: {
        sections: {
          allergies: ts("allergies"),
          medications: ts("medications"),
          conditions: ts("conditions"),
          birth_history: ts("birth_history"),
          developmental_history: ts("developmental_history"),
          emergency_contact: ts("emergency_contact"),
          blood_group: ts("blood_group"),
        },
        notRecorded: t("notRecorded"),
        noKnownAllergies: t("nka"),
        severity: { mild: tsev("mild"), moderate: tsev("moderate"), severe: tsev("severe"), unknown: tsev("unknown") },
        since: tf("since").replace(/\s*\(YYYY-MM\)\s*$/, ""),
      },
    };
  } catch {
    return { title: TITLE, labels: ENGLISH_HEALTH_LABELS };
  }
}

export const healthProfileLoader: ShareLoader = {
  /** One item (id = child id) per source org that shared the scope, if the guardian saved a profile. */
  async list(ctx) {
    if (ctx.sourceOrgIds.length === 0) return [];
    const profile = await getHealthProfile(ctx.childId);
    if (!profile?.updated_at) return [];
    const { title } = await labels();
    return ctx.sourceOrgIds.map(
      (sourceOrgId): SharedItem => ({ id: ctx.childId, sourceOrgId, title, date: profile.updated_at as string }),
    );
  },
  async get(ctx, itemId) {
    if (ctx.sourceOrgIds.length === 0 || !isUuid(itemId) || itemId !== ctx.childId) return null;
    const profile = await getHealthProfile(ctx.childId);
    if (!profile?.updated_at) return null;
    const { title, labels: l } = await labels();
    return {
      id: ctx.childId,
      sourceOrgId: ctx.sourceOrgIds[0],
      title,
      date: profile.updated_at,
      body: { kind: "markdown", markdown: healthProfileMarkdown(profile, l) },
    };
  },
};
