import type { Metadata } from "next";
import { AdminNav } from "@/components/admin/AdminNav";
import { DeletionReviewForm } from "@/components/admin/DeletionReviewForm";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { listDeletionRequestsForAdmin } from "@/lib/privacy/deletion";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("privacy.admin.requests");
  return { title: t("title") };
}

// 041 FR-8: platform admin review of deletion requests. Other roles: 404.
export default async function AdminDeletionRequestsPage() {
  await requirePlatformAdminPage();
  const [t, tf, format] = [await getT("privacy.admin.requests"), await getT("privacy.family"), await getFormatter()];
  const requests = await listDeletionRequestsForAdmin();

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <AdminNav current="requests" />
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <p className="text-sm text-slate-700">{t("intro")}</p>
      {requests.length === 0 ? (
        <p className="text-slate-700">{t("none")}</p>
      ) : (
        <ul className="space-y-4" data-testid="admin-deletion-requests">
          {requests.map((r) => (
            <li key={r.id} className="space-y-2 rounded border border-slate-200 bg-white p-4" data-request-id={r.id}>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-semibold text-slate-900">{t("child")}</dt>
                  <dd className="break-words">{r.child_name} <span className="font-mono text-xs text-slate-500">{r.child_id.slice(0, 8)}</span></dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">{t("scope")}</dt>
                  <dd className="font-mono">{r.scope}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">{t("status")}</dt>
                  <dd className="font-mono" data-testid="request-status">{r.status}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">{t("requested")}</dt>
                  <dd>{format.dateTime(r.created_at)}</dd>
                </div>
              </dl>
              {r.reason ? (
                <p className="text-sm">
                  <span className="font-semibold">{t("reason")}:</span> {r.reason}
                </p>
              ) : null}
              {r.review_note ? <p className="text-sm text-slate-700">{tf("rejectedReason", { note: r.review_note })}</p> : null}
              {r.processors_failed > 0 ? <p className="text-sm text-amber-800">{t("processorsPending", { count: r.processors_failed })}</p> : null}
              {r.last_error ? <p className="font-mono text-xs text-slate-600">{t("lastError", { error: r.last_error })}</p> : null}
              {r.status === "requested" ? <DeletionReviewForm requestId={r.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
