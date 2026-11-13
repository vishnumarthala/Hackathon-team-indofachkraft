"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";

type Props = {
  dailyOverride: number | null;
  monthlyOverride: number | null;
  envDaily: number;
  envMonthly: number;
};

const toValue = (raw: string): number | null | "invalid" => {
  const v = raw.trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : "invalid";
};

// 051 FR-10: platform admins change the voice budget at runtime (empty = the env default). PUT /api/admin/voice-settings
// writes the override and its `voice.caps_updated` audit row together.
export function VoiceCapsForm({ dailyOverride, monthlyOverride, envDaily, envMonthly }: Props) {
  const t = useT("privacy.admin.ops");
  const router = useRouter();
  const id = useId();
  const [daily, setDaily] = useState(dailyOverride === null ? "" : String(dailyOverride));
  const [monthly, setMonthly] = useState(monthlyOverride === null ? "" : String(monthlyOverride));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "failed" | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const d = toValue(daily);
    const m = toValue(monthly);
    if (d === "invalid" || m === "invalid") return setMessage("failed");
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/voice-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_minutes_cap: d, monthly_minutes_cap: m }),
      });
      setMessage(res.ok ? "saved" : "failed");
      if (res.ok) router.refresh();
    } catch {
      setMessage("failed");
    }
    setBusy(false);
  }

  const input = "min-h-11 w-full rounded border border-slate-300 px-2 py-1 font-mono text-sm";
  return (
    <form onSubmit={save} className="space-y-2" data-testid="voice-caps-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-daily`} className="block text-sm font-medium text-slate-800">
            {t("voiceDailyCap")}
          </label>
          <input
            id={`${id}-daily`}
            inputMode="numeric"
            value={daily}
            placeholder={String(envDaily)}
            onChange={(e) => setDaily(e.target.value)}
            className={input}
            aria-describedby={`${id}-help`}
          />
          <p className="text-xs text-slate-600">{t("voiceCapDefault", { minutes: envDaily })}</p>
        </div>
        <div>
          <label htmlFor={`${id}-monthly`} className="block text-sm font-medium text-slate-800">
            {t("voiceMonthlyCap")}
          </label>
          <input
            id={`${id}-monthly`}
            inputMode="numeric"
            value={monthly}
            placeholder={String(envMonthly)}
            onChange={(e) => setMonthly(e.target.value)}
            className={input}
            aria-describedby={`${id}-help`}
          />
          <p className="text-xs text-slate-600">{t("voiceCapDefault", { minutes: envMonthly })}</p>
        </div>
      </div>
      <p id={`${id}-help`} className="text-xs text-slate-600">
        {t("voiceCapHelp")}
      </p>
      <button type="submit" disabled={busy} className="min-h-11 rounded bg-slate-900 px-4 font-semibold text-white disabled:opacity-60">
        {busy ? t("voiceCapSaving") : t("voiceCapSave")}
      </button>
      {message ? (
        <p role={message === "saved" ? "status" : "alert"} className={message === "saved" ? "text-sm text-teal-800" : "text-sm text-red-700"}>
          {message === "saved" ? t("voiceCapSaved") : t("voiceCapFailed")}
        </p>
      ) : null}
    </form>
  );
}
