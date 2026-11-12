"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";
const buttonClass = "rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, json: await res.json().catch(() => ({})) };
}

function errorText(json: Record<string, unknown>, fallback: string): string {
  const details = json.details as Record<string, string> | undefined;
  const first = details ? Object.values(details)[0] : undefined;
  return first ?? (typeof json.error === "string" ? json.error : fallback);
}

export function CreateOrgForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const { ok, json } = await send("/api/orgs", "POST", {
      name: String(form.get("name") ?? ""),
      kind: String(form.get("kind") ?? "solo"),
      city: String(form.get("city") ?? ""),
    });
    setBusy(false);
    if (ok) router.refresh();
    else setError(errorText(json, "Could not create the organisation"));
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">Create organisation</h2>
      <div>
        <label htmlFor="org-name" className="block text-sm font-medium">Name</label>
        <input id="org-name" name="name" required maxLength={120} className={inputClass} />
      </div>
      <div>
        <label htmlFor="org-kind" className="block text-sm font-medium">Type</label>
        <select id="org-kind" name="kind" defaultValue="solo" className={inputClass}>
          <option value="solo">Solo practice</option>
          <option value="centre">Centre</option>
        </select>
      </div>
      <div>
        <label htmlFor="org-city" className="block text-sm font-medium">City</label>
        <input id="org-city" name="city" maxLength={80} defaultValue="Hyderabad" className={inputClass} />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy} className={buttonClass}>
        Create organisation
      </button>
    </form>
  );
}

export function InviteForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    setBusy(true);
    setMessage(null);
    setUrl(null);
    const form = new FormData(formEl);
    const { ok, json } = await send(`/api/orgs/${orgId}/invitations`, "POST", {
      email: String(form.get("email") ?? ""),
      org_role: String(form.get("org_role") ?? "member"),
    });
    setBusy(false);
    if (!ok) {
      setMessage(errorText(json, "Could not create the invitation"));
      return;
    }
    formEl.reset();
    setUrl(String(json.url));
    setMessage(json.emailed ? "Invitation emailed" : "Invitation created - share the link below");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={`invite-email-${orgId}`} className="block text-sm font-medium">Email</label>
        <input id={`invite-email-${orgId}`} name="email" type="email" required className={inputClass} />
      </div>
      <div>
        <label htmlFor={`invite-role-${orgId}`} className="block text-sm font-medium">Role</label>
        <select id={`invite-role-${orgId}`} name="org_role" defaultValue="member" className={inputClass}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button type="submit" disabled={busy} className={buttonClass}>
        Invite
      </button>
      {message && <p className="w-full text-sm text-slate-700">{message}</p>}
      {url && (
        <input readOnly aria-label="Invitation link" value={url} className={`${inputClass} w-full`} onFocus={(e) => e.currentTarget.select()} />
      )}
    </form>
  );
}

export function RevokeButton({ url, label, confirmText }: { url: string; label: string; confirmText: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    const { ok, json } = await send(url, "DELETE");
    setBusy(false);
    if (ok) router.refresh();
    else setError(errorText(json, "Could not revoke"));
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={onClick} disabled={busy} className="text-sm font-medium text-red-700 underline disabled:opacity-50">
        {label}
      </button>
      {error && <span className="text-sm text-red-700">{error}</span>}
    </span>
  );
}

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    setError(null);
    const { ok, json } = await send("/api/invitations/accept", "POST", { token });
    setBusy(false);
    if (ok) router.push("/dashboard");
    else setError(errorText(json, "Could not accept the invitation"));
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={onClick} disabled={busy} className={buttonClass}>
        Accept invitation
      </button>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
