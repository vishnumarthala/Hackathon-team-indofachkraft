import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { getConsentState, isConsentFeature, publicConsentState } from "@/lib/consent";
import { recordConsent, requestMeta } from "@/lib/consent/records";
import { fail, ok } from "@/lib/http";
import { isLocale } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

// 020 FR-13 / FR-18d: withdraw a digital or paper consent (never harder than granting: no phone check).
export async function POST(req: Request, { params }: { params: Promise<{ id: string; feature: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id, feature } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  if (!isConsentFeature(feature)) return fail(404, "Unknown permission");

  const meta = requestMeta(req);
  const saved = await recordConsent({
    childId: access.child.id,
    action: "withdrawn",
    method: "digital",
    features: [feature],
    locale: isLocale(session.profile.preferred_locale) ? session.profile.preferred_locale : "en",
    guardianUserId: session.user.id,
    guardianLinkId: access.link.id,
    ipHash: meta.ip_hash,
    userAgent: meta.user_agent,
  });
  if (!saved.ok) return fail(saved.status, saved.error);
  return ok({ state: publicConsentState(await getConsentState(access.child.id)) });
}
