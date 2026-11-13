import { audit } from "@/lib/audit";
import { fail } from "@/lib/http";
import { pdfFileName, prescriptionPdfBytes, signedVersionOf } from "@/lib/rx";
import { requirePrescriptionActor } from "@/lib/rx/authz";
import { MSG } from "@/lib/rx/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-5: `Download PDF` for the care team's prescribers (signed and void prescriptions; drafts have no PDF).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePrescriptionActor(id);
  if ("response" in gate) return gate.response;
  const found = await signedVersionOf(id);
  if (!found) return fail(404, MSG.notFound);
  const bytes = await prescriptionPdfBytes(found.version);
  await audit({ caseId: gate.caseId, action: "rx.pdf_downloaded", entity: "prescription", entityId: id, details: { version: found.version.version } });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFileName(found.version)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
