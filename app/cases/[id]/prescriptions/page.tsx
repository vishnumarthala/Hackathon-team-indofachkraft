import { notFound } from "next/navigation";
import { PrescriptionsPanel, type PanelDetail } from "@/components/rx/PrescriptionsPanel";
import { getCase } from "@/lib/queries/cases";
import { getPrescribingHealthFacts } from "@/lib/queries/health";
import { getPrescriptionDetail, getRxDraftReport, itemsFromDraft, listCasePrescriptions, prescriptionForReport } from "@/lib/rx";
import { requirePrescriberCasePage } from "@/lib/rx/authz";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// 039 FR-5: case workspace `Prescriptions` tab. Verified prescribers with case access only (others 404; the tab is
// hidden for them). `?from_report_id=<rx_draft id>` (038's `Review in prescriptions`) shows the AI draft card;
// `?rx=<id>` selects a prescription of this case.
export default async function CasePrescriptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rx?: string | string[]; from_report_id?: string | string[] }>;
}) {
  const { id } = await params;
  await requirePrescriberCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) notFound();

  const sp = await searchParams;
  const fromReportId = first(sp.from_report_id);
  const wanted = first(sp.rx);
  const [list, facts, report] = await Promise.all([
    listCasePrescriptions(id),
    getPrescribingHealthFacts(caseRow.child_id),
    fromReportId ? getRxDraftReport(id, fromReportId) : null,
  ]);
  const startedId = report ? await prescriptionForReport(id, report.id) : null;
  const selectedId = list.find((p) => p.id === wanted)?.id ?? startedId ?? list.find((p) => p.status === "draft")?.id ?? null;
  const detail = selectedId ? await getPrescriptionDetail(selectedId, id) : null;

  const selected: PanelDetail | null = detail
    ? {
        id: detail.prescription.id,
        status: detail.prescription.status,
        version: detail.prescription.version,
        void_reason: detail.prescription.void_reason,
        voided_at: detail.prescription.voided_at,
        items: detail.current.items,
        advice: detail.current.advice,
        follow_up: detail.current.follow_up,
        signed_at: detail.current.signed_at,
        content_hash: detail.current.content_hash,
        prescriber_name: detail.prescriber_name,
      }
    : null;

  return (
    <PrescriptionsPanel
      caseId={id}
      list={list.map(({ drugs: _drugs, ...rest }) => (void _drugs, rest))}
      selected={selected}
      draftReport={report ? { id: report.id, items: itemsFromDraft(report.content) } : null}
      draftStartedId={startedId}
      health={{
        recorded: facts.recorded,
        noKnownAllergies: facts.noKnownAllergies,
        allergies: facts.allergies.map((a) => ({ substance: a.substance, severity: a.severity ?? "unknown", reaction: a.reaction ?? "" })),
        medications: facts.medications.map((m) => ({ name: m.name, dose: m.dose, frequency: m.frequency })),
      }}
    />
  );
}
