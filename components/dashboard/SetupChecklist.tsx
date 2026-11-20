import Link from "next/link";
import { Card } from "@/components/ui/Card";
import type { SetupStep } from "@/lib/dashboard/setup";
import { getT } from "@/lib/i18n/server";

// Ticket 056: the new centre's first-run checklist (hidden once every step is done).
export async function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const t = await getT("dashboard.setup");
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.find((s) => !s.done);
  return (
    <Card as="section" aria-labelledby="setup-title" className="space-y-3 border-teal-200 bg-teal-50/40" data-testid="setup-checklist">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="setup-title" className="text-lg font-semibold text-slate-900">
          {t("title")}
        </h2>
        <p className="text-sm text-slate-600">{t("progress", { done, total: steps.length })}</p>
      </div>
      <p className="text-sm text-slate-700">{t("intro")}</p>
      <ol className="space-y-1">
        {steps.map((s, i) => (
          <li key={s.id} data-testid={`setup-${s.id}`} data-done={s.done}>
            {s.done ? (
              <p className="flex min-h-11 items-center gap-3 text-sm text-slate-500">
                <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-700 text-xs text-white">
                  ✓
                </span>
                <span className="line-through">{t(`steps.${s.id}.title`)}</span>
                <span className="sr-only">{t("doneLabel")}</span>
              </p>
            ) : (
              <Link
                href={s.href}
                className={`flex min-h-11 items-start gap-3 rounded-lg px-1 py-2 text-sm hover:bg-white ${s === next ? "font-semibold" : ""}`}
              >
                <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-teal-700 text-xs text-teal-800">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-teal-900 underline underline-offset-4">{t(`steps.${s.id}.title`)}</span>
                  <span className="block font-normal text-slate-600">{t(`steps.${s.id}.text`)}</span>
                </span>
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
