"use client";

import { usePathname, useRouter } from "next/navigation";

export type SessionOption = { id: string; session_number: number | null };

export function sessionLabel(s: SessionOption): string {
  return `Session ${s.session_number ?? "?"}`;
}

export function sessionHref(pathname: string, sessionId: string): string {
  return `${pathname}?session=${encodeURIComponent(sessionId)}`;
}

export function SessionSelect({ sessions, selectedId }: { sessions: SessionOption[]; selectedId: string }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  return (
    <div>
      <label htmlFor="report-session" className="block text-sm font-medium text-slate-800">
        Session
      </label>
      <select
        id="report-session"
        value={selectedId}
        onChange={(e) => router.push(sessionHref(pathname, e.target.value))}
        className="mt-1 min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {sessionLabel(s)}
          </option>
        ))}
      </select>
    </div>
  );
}
