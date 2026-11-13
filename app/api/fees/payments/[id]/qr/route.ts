import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { staffCanSeeAccount } from "@/lib/fees/authz";
import { linkQrSvg } from "@/lib/fees/qr";
import { getPaymentScope } from "@/lib/fees/store";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-3 `Show QR`: an SVG QR code of an open payment link, for the desk screen. Staff with access to one of the
// child's cases in the link's organisation; everyone else 404. NFR-3: the code holds the short URL only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await requireProviderApi();
  if ("response" in g) return g.response;
  if (!isUuid(id)) return fail(404, "Payment not found");
  const payment = await getPaymentScope(id);
  if (!payment || payment.purpose === "appointment" || !payment.child_id || !payment.url) return fail(404, "Payment not found");
  if (!(await staffCanSeeAccount(g.actor.user.id, payment.org_id, payment.child_id))) return fail(404, "Payment not found");
  if (payment.status !== "created") return fail(409, "This payment link is closed");
  const svg = await linkQrSvg(payment.url);
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, no-store" } });
}
