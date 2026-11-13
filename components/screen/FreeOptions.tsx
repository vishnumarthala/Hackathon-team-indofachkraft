"use client";

import { useFormatter, useT } from "@/lib/i18n/client";
import { FREE_SERVICES, FREE_SERVICES_LAST_CHECKED } from "@/lib/screen/free-services";

// Ticket 048 FR-7: free government options on every non-urgent result (static, lib/screen/free-services.ts).
export function FreeOptions() {
  const t = useT("screen.free");
  const format = useFormatter();
  return (
    <section aria-labelledby="screen-free-title" className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-6" data-testid="screen-free">
      <h2 id="screen-free-title" className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <p className="text-slate-800">{t("intro")}</p>
      <ul className="space-y-3">
        {FREE_SERVICES.map((s) => (
          <li key={s.key} className="space-y-1 rounded-xl bg-white p-3" data-service={s.key}>
            <h3 className="font-semibold text-slate-900">{s.name}</h3>
            <p className="text-sm text-slate-800">{t(`services.${s.key}.what`)}</p>
            {s.key === "deic" ? <p className="text-sm text-slate-700">{t("services.deic.contact")}</p> : null}
            <dl className="space-y-0.5 text-sm text-slate-700">
              {s.address ? (
                <div>
                  <dt className="inline font-medium">{t("address")}: </dt>
                  <dd className="inline">{s.address}</dd>
                </div>
              ) : null}
              {s.phone ? (
                <div>
                  <dt className="inline font-medium">{t("phone")}: </dt>
                  <dd className="inline">
                    <a href={`tel:${s.phone.tel}`} className="text-teal-800 underline">
                      {s.phone.display}
                    </a>
                  </dd>
                </div>
              ) : null}
              {s.tollFree ? (
                <div>
                  <dt className="inline font-medium">{t("tollFree")}: </dt>
                  <dd className="inline">
                    <a href={`tel:${s.tollFree.tel}`} className="text-teal-800 underline">
                      {s.tollFree.display}
                    </a>
                  </dd>
                </div>
              ) : null}
              {s.url ? (
                <div>
                  <dt className="inline font-medium">{t("website")}: </dt>
                  <dd className="inline">
                    <a href={s.url} className="text-teal-800 underline" rel="noopener noreferrer" target="_blank">
                      {s.url.replace(/^https:\/\//, "").replace(/\/$/, "")}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      <p className="font-medium text-slate-900">{t("checkTimings")}</p>
      <p className="text-xs text-slate-600">{t("lastChecked", { date: format.date(`${FREE_SERVICES_LAST_CHECKED}T12:00:00Z`, "long") })}</p>
    </section>
  );
}
