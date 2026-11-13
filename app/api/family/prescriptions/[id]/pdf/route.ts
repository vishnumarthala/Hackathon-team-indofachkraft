import { audit } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { fail } from "@/lib/http";
import { pdfFileName, prescriptionPdfBytes, signedVersionOf } from "@/lib/rx";
import { requireGuardianPrescription } from "@/lib/rx/authz";
import { MSG } from "@/lib/rx/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-5: guardian `Download PDF`: signed (not cancelled) prescriptions published to guardians, active link to the
// child; drafts, cancelled prescriptions and other families' ids -> 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireGuardianPrescription(id, session);
  if (access instanceof Response) return access;
  const found = await signedVersionOf(id);
  if (!found || found.prescription.status !== "signed") return fail(404, MSG.notFound);
  const bytes = await prescriptionPdfBytes(found.version);
  await audit({ childId: access.childId, action: "rx.pdf_downloaded", entity: "prescription", entityId: id, details: { version: found.version.version } });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFileName(found.version)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
