import { requireCaseActor } from "@/lib/authz";
import { CLAIM_CODE_TTL_HOURS, claimMessage, generateClaimCode, hashClaimCode, normalizeClaimCode, storeClaimCode } from "@/lib/children";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/http";
import { whatsappUrl } from "@/lib/intake/message";
import { getCase } from "@/lib/queries/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 020 FR-12: a one-time parent code (shown once; only its hash is stored). A new code replaces older ones.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const caseRow = await getCase(id);
  if (!caseRow) return fail(404, "Case not found");

  const code = generateClaimCode();
  let stored;
  try {
    stored = await storeClaimCode(id, hashClaimCode(normalizeClaimCode(code) as string), gate.actor.user.id, CLAIM_CODE_TTL_HOURS);
  } catch (err) {
    console.error(`claim code failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not create the code. Please try again.");
  }
  const message = claimMessage(caseRow, env.NEXT_PUBLIC_APP_URL, code);
  return ok({ code, expires_at: stored.expires_at, whatsapp_url: whatsappUrl(caseRow.parent_phone, message) }, 201);
}
