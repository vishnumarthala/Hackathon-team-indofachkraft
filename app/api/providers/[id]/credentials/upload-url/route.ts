import { requireProviderProfileOwner } from "@/lib/authz";
import { ok, parseJson } from "@/lib/http";
import { CertificateUploadSchema } from "@/lib/providers/schemas";
import { createCertificateUpload } from "@/lib/providers/verification";

export const dynamic = "force-dynamic";

// Signed upload to the private `credentials` bucket (the bucket enforces 10 MB and PDF/JPEG/PNG).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;

  const parsed = await parseJson(req, CertificateUploadSchema);
  if ("response" in parsed) return parsed.response;

  const { path, token } = await createCertificateUpload(id, parsed.data.mime_type);
  return ok({ path, token }, 201);
}
