// Ticket 035 FR-6: the case's appointment intake calls on the Brief tab (server component). Each appointment has an
// anchor (`#appointment-<id>`) the provider agenda links to. The brief text is the stored Markdown (English, like
// every clinical document); only the chrome is translated.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { getFormatter, getT } from "@/lib/i18n/server";
import type { CaseIntakeEntry } from "@/lib/intake/attempts";

// Stored briefs start at `##`; inside this section they sit below the h3 of their appointment.
const MARKDOWN: Components = {
  h2: ({ children }) => <h4 className="text-base font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-3 text-sm font-semibold">{children}</h5>,
  p: ({ children }) => <p className="mt-1 text-sm">{children}</p>,
  ul: ({ children }) => <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{children}</ol>,
  table: ({ children }) => (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-slate-300 py-1 pr-3 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-slate-100 py-1 pr-3 align-top">{children}</td>,
};

export async function AppointmentIntakes({ entries }: { entries: CaseIntakeEntry[] }) {
  if (entries.length === 0) return null;
  const t = await getT("intake.appointments");
  const format = await getFormatter();
  return (
    <section aria-labelledby="appointment-intakes" className="space-y-4">
      <div>
        <h2 id="appointment-intakes" className="text-lg font-semibold text-slate-900">
          {t("title")}
        </h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>
      <ul className="space-y-4">
        {entries.map((e) => (
          <li
            key={e.attempt_id}
            id={`appointment-${e.appointment_id}`}
            className="scroll-mt-4 space-y-3 rounded border border-slate-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-slate-900">
                {t("heading", { service: e.service_name, date: format.dateTime(e.starts_at) })}
              </h3>
              <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900">
                {t(e.agent_kind === "generic" ? "generic" : "childDev")}
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800">
                {t(e.status === "completed" ? "completed" : "notStarted")}
              </span>
              {e.report ? (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800">
                  {t(e.report.status === "final" ? "reviewed" : "draft")}
                </span>
              ) : null}
            </div>
            {e.status === "completed" && !e.report ? (
              <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
                {t("briefFailed")}
              </p>
            ) : null}
            {e.report ? (
              <div className="text-slate-900" data-report-kind={e.report.kind}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
                  {e.report.content_md}
                </ReactMarkdown>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
