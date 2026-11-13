"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { allowScreenSave, saveToChild } from "@/lib/screen/client";
import { primaryButton, secondaryButton } from "./view";

export type ConsentDoc = {
  id: string;
  title: string;
  version: number;
  body: string;
  processors: { name: string; purpose: string; location: string }[];
};

export type SaveViewer =
  | { kind: "anonymous" }
  | { kind: "other" }
  | { kind: "guardian"; children: { id: string; name: string }[]; consentDocument: ConsentDoc | null };

type Message = "verifyPhone" | "outdated" | "expired" | "notSavable" | "failed";

// Ticket 033 FR-8: `Save this result to <child>` for a signed-in guardian. Nothing about the child is collected before
// this point (rule 6). Missing `screen_result_save` consent -> 422 -> the inline `Allow` dialog with the exact
// consent text (020), then the save is retried.
export function SaveResult({ sessionId, viewer, onSaved }: { sessionId: string; viewer: SaveViewer; onSaved: () => void }) {
  const t = useT("screen.save");
  const tc = useT("consent");
  const router = useRouter();
  const id = useId();
  const children = viewer.kind === "guardian" ? viewer.children : [];
  const [childId, setChildId] = useState(children[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const child = children.find((c) => c.id === childId) ?? null;

  async function save() {
    if (!child) return;
    setBusy(true);
    setMessage(null);
    const outcome = await saveToChild(fetch, sessionId, child.id);
    setBusy(false);
    if (outcome.kind === "saved") {
      setSaved(child);
      setConsentFor(null);
      onSaved();
    } else if (outcome.kind === "consent") {
      setAgree(false);
      setConsentFor(child.id);
    } else if (outcome.kind === "signIn") {
      router.push(`/family/login?next=${encodeURIComponent("/screen")}`);
    } else {
      setMessage(outcome.error);
    }
  }

  async function allow() {
    if (!child || viewer.kind !== "guardian" || !viewer.consentDocument) return;
    setBusy(true);
    setMessage(null);
    const result = await allowScreenSave(fetch, child.id, viewer.consentDocument.id);
    setBusy(false);
    if (result === "allowed") return save();
    setMessage(result);
  }

  if (saved) {
    return (
      <section className="space-y-2 rounded-2xl border border-teal-200 bg-teal-50 p-4 sm:p-6" data-testid="screen-saved">
        <p role="status" className="font-semibold text-teal-900">
          {t("saved", { child: saved.name })}
        </p>
        <Link href={`/family/children/${saved.id}`} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
          {t("viewChild", { child: saved.name })}
        </Link>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="screen-save">
      <h2 id={`${id}-title`} className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <p className="text-slate-700">{t("intro")}</p>

      {viewer.kind === "anonymous" ? (
        <Link href={`/family/login?next=${encodeURIComponent("/screen")}`} className={secondaryButton}>
          {t("signIn")}
        </Link>
      ) : null}
      {viewer.kind === "other" ? <p className="text-sm text-slate-700">{t("notGuardian")}</p> : null}
      {viewer.kind === "guardian" && children.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">{t("noChildren")}</p>
          <Link href="/family/children/new" className={secondaryButton}>
            {t("addChild")}
          </Link>
        </div>
      ) : null}

      {viewer.kind === "guardian" && children.length > 0 ? (
        <div className="space-y-3">
          {children.length > 1 ? (
            <div>
              <label htmlFor={`${id}-child`} className="mb-1 block text-sm font-semibold text-slate-800">
                {t("child")}
              </label>
              <select
                id={`${id}-child`}
                value={childId}
                disabled={busy || consentFor !== null}
                onChange={(e) => setChildId(e.target.value)}
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base"
              >
                {children.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {consentFor === null && child ? (
            <button type="button" className={primaryButton} disabled={busy} onClick={save}>
              {busy ? t("saving") : t("saveTo", { child: child.name })}
            </button>
          ) : null}
        </div>
      ) : null}

      {consentFor !== null && child && viewer.kind === "guardian" ? (
        <div role="dialog" aria-labelledby={`${id}-consent`} className="space-y-3 rounded-xl border-2 border-teal-700 bg-white p-4" data-testid="screen-consent">
          <h3 id={`${id}-consent`} className="text-lg font-semibold text-slate-900">
            {t("consentTitle", { child: child.name })}
          </h3>
          {viewer.consentDocument ? (
            <>
              <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                {viewer.consentDocument.processors.map((p) => (
                  <li key={`${p.name}-${p.purpose}`}>{tc("processor", p)}</li>
                ))}
              </ul>
              <details className="rounded-xl bg-slate-50 p-3">
                <summary className="min-h-11 cursor-pointer py-2 font-semibold text-teal-800">{t("readFull")}</summary>
                <h4 className="mt-2 font-semibold text-slate-900">{viewer.consentDocument.title}</h4>
                <p className="mt-2 text-sm whitespace-pre-line text-slate-800">{viewer.consentDocument.body.replace(/\*\*/g, "")}</p>
                <p className="mt-2 text-xs text-slate-500">{tc("version", { version: viewer.consentDocument.version })}</p>
              </details>
              <div className="flex items-start gap-3">
                <input id={`${id}-agree`} type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <label htmlFor={`${id}-agree`} className="text-sm text-slate-900">
                  {t("consentAgree")}
                </label>
              </div>
            </>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" className={primaryButton} disabled={busy || !agree || !viewer.consentDocument} onClick={allow}>
              {busy ? t("saving") : t("allow")}
            </button>
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConsentFor(null)}>
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {t(message)}
          {message === "verifyPhone" ? (
            <>
              {" "}
              <Link href="/family/settings" className="underline">
                {t("verifyLink")}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
