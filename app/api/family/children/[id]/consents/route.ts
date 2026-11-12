import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { ConsentGrantSchema } from "@/lib/children";
import { getConsentState, publicConsentState } from "@/lib/consent";
import { documentsByIds, OUTDATED_TEXT, recordConsent, requestMeta, VERIFY_PHONE } from "@/lib/consent/records";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// 020 FR-13: a linked guardian with a verified mobile number allows one feature, for the exact text shown.
// Providers get 403 (requireGuardian): only guardians can ever give consent digitally.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  return ok({ state: publicConsentState(await getConsentState(access.child.id)) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const parsed = await parseJson(req, ConsentGrantSchema);
  if ("response" in parsed) return parsed.response;
  const { feature, consent_document_id } = parsed.data;

  if (!session.profile.phone_verified_at) return fail(422, VERIFY_PHONE, { settings_url: "/family/settings" });
  const [doc] = await documentsByIds([consent_document_id]);
  if (!doc || doc.feature !== feature) return fail(400, "Invalid request", { consent_document_id: "Unknown consent text" });

  const meta = requestMeta(req);
  const saved = await recordConsent({
    childId: access.child.id,
    action: "granted",
    method: "digital",
    features: [feature],
    documentIds: [doc.id],
    locale: doc.locale,
    guardianUserId: session.user.id,
    guardianLinkId: access.link.id,
    ipHash: meta.ip_hash,
    userAgent: meta.user_agent,
  });
  if (!saved.ok) {
    if (saved.error === VERIFY_PHONE) return fail(422, VERIFY_PHONE, { settings_url: "/family/settings" });
    return fail(saved.status, saved.error === OUTDATED_TEXT ? OUTDATED_TEXT : saved.error);
  }
  return ok({ state: publicConsentState(await getConsentState(access.child.id)) }, 201);
}
