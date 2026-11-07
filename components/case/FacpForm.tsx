"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function FacpForm({ caseId, initialScore }: { caseId: string; initialScore: number | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initialScore === null ? "" : String(initialScore));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    const trimmed = value.trim();
    const facp_score = trimmed === "" ? null : Number(trimmed);
    try {
      const res = await fetch(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facp_score: Number.isNaN(facp_score) ? trimmed : facp_score }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage({ ok: true, text: "Saved" });
        router.refresh();
      } else {
        setMessage({ ok: false, text: json.details?.facp_score ?? json.error ?? "Could not save" });
      }
    } catch {
      setMessage({ ok: false, text: "Could not save" });
    }
    setSaving(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="facp_score" className="block text-sm font-medium text-slate-800">
          FACP score (0-100)
        </label>
        <input
          id="facp_score"
          name="facp_score"
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-32 rounded border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <button type="submit" disabled={saving} className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
        Save FACP score
      </button>
      {message && (
        <p role="status" className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>
          {message.text}
        </p>
      )}
    </form>
  );
}
