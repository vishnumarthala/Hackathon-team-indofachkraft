"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";

export type TeamMemberView = {
  assignmentId: string;
  name: string | null;
  discipline: string | null;
  careRole: "lead" | "member";
  memberActive: boolean;
  isSelf: boolean;
};

export type CandidateView = { userId: string; name: string; typeLabel: string | null };

type ErrorKey = "lastLead" | "notInOrg" | "alreadyOnTeam" | "managersOnly" | "saveFailed";

/** Maps the API's answers (English contract) to translated messages. */
export function teamErrorKey(method: "POST" | "PATCH" | "DELETE", status: number): ErrorKey {
  if (status === 403) return "managersOnly";
  if (status === 422 && method === "POST") return "notInOrg";
  if (status === 409) return method === "POST" ? "alreadyOnTeam" : "lastLead";
  return "saveFailed";
}

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";
const buttonClass = "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
const linkButtonClass = "min-h-9 rounded border border-slate-300 px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50";

// 022 FR-3: `<name> - <discipline> - Lead/Member`, `Add provider` and `Remove` (owners/admins/lead only).
export function CareTeamPanel({
  caseId,
  members,
  candidates,
  manage,
}: {
  caseId: string;
  members: TeamMemberView[];
  candidates: CandidateView[];
  manage: boolean;
}) {
  const t = useT("careTeam");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [selected, setSelected] = useState("");

  async function send(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        setError(teamErrorKey(method, res.status));
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("saveFailed");
      return false;
    }
  }

  async function remove(member: TeamMemberView) {
    if (!window.confirm(t("removeConfirm", { name: member.name ?? t("unnamed") }))) return;
    setBusy(member.assignmentId);
    await send("DELETE", `/api/cases/${caseId}/assignments/${member.assignmentId}`);
    setBusy(null);
  }

  async function makeLead(member: TeamMemberView) {
    setBusy(member.assignmentId);
    await send("PATCH", `/api/cases/${caseId}/assignments/${member.assignmentId}`, { care_role: "lead" });
    setBusy(null);
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy("add");
    const saved = await send("POST", `/api/cases/${caseId}/assignments`, {
      user_id: String(data.get("user_id") ?? ""),
      care_role: String(data.get("care_role") ?? "member"),
      discipline_label: String(data.get("discipline_label") ?? ""),
    });
    setBusy(null);
    if (saved) {
      form.reset();
      setSelected("");
    }
  }

  const placeholder = candidates.find((c) => c.userId === selected)?.typeLabel ?? undefined;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t(error)}
        </p>
      ) : null}

      {members.length === 0 ? (
        <p className="text-slate-700">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white" aria-label={t("title")}>
          {members.map((m) => (
            <li key={m.assignmentId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-assignment={m.assignmentId}>
              <div className="min-w-0 text-sm">
                <span className="font-medium break-words text-slate-900">
                  {m.name ?? t("unnamed")} {m.isSelf ? <span className="font-normal text-slate-600">{t("you")}</span> : null}
                </span>
                {m.discipline ? <span className="text-slate-700"> - {m.discipline}</span> : null}
                <span className="text-slate-700"> - {m.careRole === "lead" ? t("lead") : t("member")}</span>
                {!m.memberActive ? <span className="ml-2 text-xs text-amber-800">{t("leftOrg")}</span> : null}
              </div>
              {manage ? (
                <div className="flex gap-2">
                  {m.careRole !== "lead" && m.memberActive ? (
                    <button type="button" className={linkButtonClass} disabled={busy !== null} onClick={() => makeLead(m)}>
                      {t("makeLead")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={linkButtonClass}
                    disabled={busy !== null}
                    onClick={() => remove(m)}
                    aria-label={`${t("remove")}: ${m.name ?? t("unnamed")}`}
                  >
                    {busy === m.assignmentId ? t("removing") : t("remove")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {manage ? (
        candidates.length === 0 ? (
          <p className="text-sm text-slate-700">{t("noCandidates")}</p>
        ) : (
          <form onSubmit={add} className="max-w-lg space-y-3 rounded border border-slate-200 bg-white p-4">
            <h3 className="text-base font-semibold">{t("addTitle")}</h3>
            <div>
              <label htmlFor="team-user" className="block text-sm font-medium">{t("person")}</label>
              <select
                id="team-user"
                name="user_id"
                required
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className={inputClass}
              >
                <option value="" disabled>
                  {t("choose")}
                </option>
                {candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="team-discipline" className="block text-sm font-medium">{t("discipline")}</label>
              <input
                id="team-discipline"
                name="discipline_label"
                maxLength={60}
                placeholder={placeholder}
                aria-describedby="team-discipline-hint"
                className={inputClass}
              />
              <p id="team-discipline-hint" className="mt-1 text-xs text-slate-600">{t("disciplineHint")}</p>
            </div>
            <div>
              <label htmlFor="team-role" className="block text-sm font-medium">{t("role")}</label>
              <select id="team-role" name="care_role" defaultValue="member" className={inputClass}>
                <option value="member">{t("member")}</option>
                <option value="lead">{t("lead")}</option>
              </select>
            </div>
            <button type="submit" disabled={busy !== null} className={buttonClass}>
              {busy === "add" ? t("adding") : t("add")}
            </button>
          </form>
        )
      ) : (
        <p className="text-sm text-slate-600">{t("managersOnly")}</p>
      )}
    </div>
  );
}
