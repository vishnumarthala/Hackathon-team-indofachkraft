import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { requirePayoutsOrgApi } from "@/lib/payouts/authz";
import { invoiceFileName, renderInvoicePdf } from "@/lib/payouts/invoice";
import { getInvoice } from "@/lib/payouts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 046 FR-7: a monthly platform-fee tax invoice (PDF) of this organisation. Owner/admin; members 403; another
// organisation's invoice id or another organisation 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; invoiceId: string }> }) {
  const { id, invoiceId } = await params;
  const g = await requirePayoutsOrgApi(id);
  if ("response" in g) return g.response;
  if (!isUuid(invoiceId)) return fail(404, "Invoice not found");
  const invoice = await getInvoice(id, invoiceId);
  if (!invoice) return fail(404, "Invoice not found");
  const bytes = await renderInvoicePdf(invoice);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoiceFileName(invoice.invoice_no)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
