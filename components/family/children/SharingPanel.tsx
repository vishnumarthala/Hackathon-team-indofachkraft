"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { primaryButtonClass, secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useFormatter, useT } from "@/lib/i18n/client";
import { SHARE_SCOPES, type ShareScope } from "@/lib/sharing/scopes";

export type SharingPairView = {
  sourceOrgId: string;
  sourceName: string;
  granteeOrgId: string;
  granteeName: string;
  grant: { id: string; scopes: ShareScope[]; expiresAt: string | null } | null;
};

type ErrorKey = "chooseScope" | "notTreating" | "saveFailed";

/** Maps the grant API's answers (English contract) to translated messages. */
export function sharingErrorKey(status: number): ErrorKey {
  return status === 422 ? "notTreating" : "saveFailed";
}

const EXPIRY = [
  { value: "", key: "forever" },
  { value: "90", key: "months3" },
  { value: "365", key: "months12" },
] as const;

function PairCard({ childId, pair }: { childId: string; pair: SharingPairView }) {
  const t = useT("family.children.team");
  const ts = useT("sharing.scopes");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  async function send(url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) setError(sharingErrorKey(res.status));
      else router.refresh();
    } catch {
      setError("saveFailed");
    }
    setBusy(false);
  }

  function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const scopes = data.getAll("scopes").map(String);
    if (scopes.length === 0) {
      setError("chooseScope");
      return;
    }
    const days = String(data.get("expiry") ?? "");
    void send(`/api/family/children/${childId}/sharing-grants`, {
      source_org_id: pair.sourceOrgId,
      grantee_org_id: pair.granteeOrgId,
      scopes,
      expires_in_days: days ? Number(days) : null,
    });
  }

  function stop() {
    if (!pair.grant || !window.confirm(t("stopConfirm", { org: pair.granteeName }))) return;
    void send(`/api/family/children/${childId}/sharing-grants/${pair.grant.id}/revoke`);
  }

  return (
    <li className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" data-pair={`${pair.sourceOrgId}:${pair.granteeOrgId}`}>
      <h3 className="font-semibold break-words text-slate-900">{t("pair", { from: pair.sourceName, to: pair.granteeName })}</h3>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {t(error)}
        </p>
      ) : null}
      {pair.grant ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-800">
            {t("sharedScopes", { scopes: pair.grant.scopes.map((s) => ts(s)).join(", ") })}
          </p>
          <p className="text-sm text-slate-600">
            {pair.grant.expiresAt ? t("sharedUntil", { date: format.date(pair.grant.expiresAt, "long") }) : t("sharedUntilStopped")}
          </p>
          <button type="button" className={secondaryButtonClass} onClick={stop} disabled={busy}>
            {busy ? t("stopping") : t("stop")}
          </button>
        </div>
      ) : (
        <details className="rounded-xl bg-slate-50 p-3">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold text-teal-800">{t("share")}</summary>
          <form onSubmit={share} className="mt-2 space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-slate-900">{t("what")}</legend>
              {SHARE_SCOPES.map((scope) => (
                <div key={scope} className="flex items-center gap-3">
                  <input id={`${id}-${scope}`} type="checkbox" name="scopes" value={scope} className="h-5 w-5 shrink-0" />
                  <label htmlFor={`${id}-${scope}`} className="min-h-11 content-center text-sm text-slate-900">
                    {ts(scope)}
                  </label>
                </div>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-slate-900">{t("howLong")}</legend>
              {EXPIRY.map((option) => (
                <div key={option.key} className="flex items-center gap-3">
                  <input
                    id={`${id}-exp-${option.key}`}
                    type="radio"
                    name="expiry"
                    value={option.value}
                    defaultChecked={option.value === ""}
                    className="h-5 w-5 shrink-0"
                  />
                  <label htmlFor={`${id}-exp-${option.key}`} className="min-h-11 content-center text-sm text-slate-900">
                    {t(option.key)}
                  </label>
                </div>
              ))}
            </fieldset>
            <button type="submit" className={`${primaryButtonClass} sm:w-auto`} disabled={busy}>
              {busy ? t("saving") : t("share")}
            </button>
          </form>
        </details>
      )}
    </li>
  );
}

// 022 FR-4: one card per ordered pair of organisations treating the child: `Share` or `Stop sharing`.
export function SharingPanel({ childId, pairs }: { childId: string; pairs: SharingPairView[] }) {
  return (
    <ul className="space-y-4">
      {pairs.map((pair) => (
        <PairCard key={`${pair.sourceOrgId}:${pair.granteeOrgId}`} childId={childId} pair={pair} />
      ))}
    </ul>
  );
}
