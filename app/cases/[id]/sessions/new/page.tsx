import { notFound } from "next/navigation";
import { UploadPanel } from "@/components/session/UploadPanel";
import { supabaseAdmin } from "@/lib/db";
import { pg } from "@/lib/pg";
import { getCase } from "@/lib/queries/cases";
import { requireCasePage } from "@/lib/authz";
import { listCaseAppointments } from "@/lib/scribe/appointments";
import { defaultTemplateFor } from "@/lib/scribe/templates";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();
  // 038 FR-2/FR-3: `Session type` defaults to the provider's template; appointments of this child in this org.
  const [{ data: profile }, appointments] = await Promise.all([
    supabaseAdmin().from("provider_profiles").select("provider_type").eq("user_id", actor.user.id).maybeSingle(),
    listCaseAppointments(await pg(), { id: caseRow.id, org_id: caseRow.org_id, child_id: caseRow.child_id ?? null }),
  ]);
  const defaultTemplate = defaultTemplateFor((profile as { provider_type: string } | null)?.provider_type);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">New session</h2>
      <p className="text-sm text-slate-700">
        AI documents, the clinician decides. Upload the recording, then review every suggested rating.
      </p>
      <UploadPanel
        caseId={id}
        scribe={{
          defaultTemplate,
          appointments: appointments.map((a) => ({ id: a.id, starts_at: a.starts_at, mode: a.mode })),
        }}
      />
    </div>
  );
}
