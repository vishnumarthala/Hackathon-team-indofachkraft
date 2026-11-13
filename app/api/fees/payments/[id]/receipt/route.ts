import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { isUuid } from "@/lib/cases/validation";
import { guardianOfChild, staffCanSeeAccount } from "@/lib/fees/authz";
import { loadReceipt, receiptFileName, renderReceiptPdf } from "@/lib/fees/receipt";
import { getPaymentScope } from "@/lib/fees/store";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-6: the receipt PDF of a captured payment. Guardians of the child (or the guardian who booked a one-off) and
// staff with access to one of the child's cases in the payment's organisation; everyone else 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  if (!isUuid(id)) return fail(404, "Receipt not found");
  const payment = await getPaymentScope(id);
  if (!payment) return fail(404, "Receipt not found");
  const role = await getUserRole(user.id);
  const allowed =
    role === "guardian"
      ? payment.guardian_user_id === user.id || (payment.child_id !== null && (await guardianOfChild(user.id, payment.child_id)))
      : payment.child_id !== null && (await staffCanSeeAccount(user.id, payment.org_id, payment.child_id));
  if (!allowed) return fail(404, "Receipt not found");
  const receipt = await loadReceipt(id);
  if (!receipt) return fail(404, "Receipt not found");
  const bytes = await renderReceiptPdf(receipt);
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${receiptFileName(receipt.receipt_no)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
