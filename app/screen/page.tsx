import type { Metadata } from "next";
import { ScreenFlow, type ScreenReferral } from "@/components/screen/ScreenFlow";
import { enabledVoiceLanguages } from "@/lib/agents/call-language";
import type { SaveViewer } from "@/components/screen/SaveResult";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { listGuardianChildren } from "@/lib/children";
import { currentDocuments } from "@/lib/consent/records";
import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";
import { KNOWN_LOCALITIES, lookupLocality } from "@/lib/geo/geocode";
import { getLocale, getT } from "@/lib/i18n/server";
import { resolveReferrer } from "@/lib/referrals";
import { turnstileSiteKey } from "@/lib/turnstile";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("screen");
  return { title: { absolute: `${t("metaTitle")} | DoctorNearMe` }, description: t("metaDescription") };
}

/** 054: `?ref=<slug>` from a provider's poster: a verified + listed profile only (as `/p/<slug>`), else no note. */
async function referralFor(ref: string | string[] | undefined): Promise<ScreenReferral | null> {
  const referrer = await resolveReferrer(ref);
  if (!referrer) return null;
  const t = await getT("providers");
  return { slug: referrer.slug, name: referrer.displayName, typeLabel: t(`types.${referrer.providerType}`) };
}

/** Viewer for FR-8: anonymous visitors see `Sign in to save`; only a guardian gets their children and the consent text. */
async function saveViewer(): Promise<SaveViewer> {
  const user = await getAuthenticatedUser().catch(() => null);
  if (!user) return { kind: "anonymous" };
  const role = await getUserRole(user.id).catch(() => null);
  if (role !== "guardian") return { kind: "other" };
  const [links, docs] = await Promise.all([listGuardianChildren(user.id), currentDocuments(await getLocale())]);
  const doc = docs.find((d) => d.feature === "screen_result_save") ?? null;
  return {
    kind: "guardian",
    children: links.map(({ child }) => ({ id: child.id, name: child.display_name })),
    consentDocument: doc ? { id: doc.id, title: doc.title, version: doc.version, body: doc.body_md, processors: doc.processors } : null,
  };
}

// Ticket 033: public developmental check-in (linked from the landing page). Strict CSP with only the ElevenLabs
// endpoints added (lib/csp.ts, NFR-1); no analytics. Translated chrome; question text English (clinical review).
// 051: tapping is anonymous; voice needs a sign-in (`?voice=1` marks the return from it) and, when configured, the
// Turnstile bot check (its site key is public). 049: voice in the page language when the agent has it, else "Voice in
// English" or tapping. 054: `?ref=<slug>` (waiting-room poster) shows "Referred by <name>"; unknown slugs are ignored.
export default async function ScreenPage({ searchParams }: { searchParams: Promise<{ voice?: string | string[]; ref?: string | string[] }> }) {
  const params = await searchParams;
  const [viewer, referral] = await Promise.all([saveViewer(), referralFor(params.ref)]);
  const voiceIntent = params.voice === "1";
  const localities = [...new Set(KNOWN_LOCALITIES)]
    .map((name) => {
      const hit = lookupLocality(name);
      return hit ? { name, lat: hit.lat, lng: hit.lng } : null;
    })
    .filter((l): l is { name: string; lat: number; lng: number } => l !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const voiceAvailable = isDemoMode() || Boolean(env.ELEVENLABS_SCREEN_AGENT_ID);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <ScreenFlow
        viewer={viewer}
        localities={localities}
        voiceAvailable={voiceAvailable}
        voiceLanguages={enabledVoiceLanguages("screen")}
        turnstileSiteKey={turnstileSiteKey()}
        voiceIntent={voiceIntent}
        referral={referral}
      />
    </div>
  );
}
