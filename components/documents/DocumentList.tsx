"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { DocumentCategory } from "@/lib/documents/constants";
import { useFormatter, useT } from "@/lib/i18n/client";
import { buttonClasses, type Tone } from "./styles";

export type DocumentView = {
  id: string;
  childId: string;
  title: string;
  category: DocumentCategory;
  createdAt: string;
  /** Translated `Uploaded by` value: `You`, `Your family`, the organisation or the provider's name. */
  uploadedBy: string;
  canDelete: boolean;
  canShare: boolean;
  canEdit: boolean;
  visibleToGuardian: boolean;
  sharedWithOrgIds: string[];
};

type ErrorKey = "saveFailed" | "forbidden" | "notTreating";

export function documentActionErrorKey(status: number): ErrorKey {
  if (status === 403) return "forbidden";
  if (status === 422) return "notTreating";
  return "saveFailed";
}

async function send(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<number> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.status;
  } catch {
    return 0;
  }
}

function DocumentItem({ doc, tone, orgs }: { doc: DocumentView; tone: Tone; orgs: { id: string; name: string }[] }) {
  const t = useT("documents");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const classes = buttonClasses(tone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  async function act(method: "POST" | "PATCH" | "DELETE", url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const status = await send(method, url, body);
    setBusy(false);
    if (status >= 200 && status < 300) router.refresh();
    else setError(documentActionErrorKey(status));
  }

  function remove() {
    if (!window.confirm(t("deleteConfirm", { title: doc.title }))) return;
    void act("DELETE", `/api/documents/${doc.id}`);
  }

  const shareBase = `/api/family/children/${doc.childId}/documents/${doc.id}/shares`;
  const sharedNames = orgs.filter((o) => doc.sharedWithOrgIds.includes(o.id)).map((o) => o.name);

  return (
    <li className="space-y-2 px-4 py-3" data-document={doc.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold break-words text-slate-900">{doc.title}</p>
          <p className="text-sm text-slate-600">
            {t(`categories.${doc.category}`)} · {t("addedOn", { date: format.date(doc.createdAt, "short") })} ·{" "}
            {t("uploadedBy", { who: doc.uploadedBy })}
          </p>
          {doc.canEdit ? (
            <p className="text-xs text-slate-600">{doc.visibleToGuardian ? t("visibleToParent") : t("hiddenFromParent")}</p>
          ) : null}
          {doc.canShare ? (
            <p className="text-xs text-slate-600">
              {sharedNames.length ? t("sharedWith", { orgs: sharedNames.join(", ") }) : t("notShared")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/documents/${doc.id}/download`} className={classes.secondary} aria-label={t("downloadLabel", { title: doc.title })}>
            {t("download")}
          </a>
          {doc.canEdit ? (
            <button
              type="button"
              className={classes.secondary}
              disabled={busy}
              onClick={() => act("PATCH", `/api/documents/${doc.id}`, { visible_to_guardian: !doc.visibleToGuardian })}
            >
              {doc.visibleToGuardian ? t("hideFromParent") : t("showToParent")}
            </button>
          ) : null}
          {doc.canDelete ? (
            <button type="button" className={classes.secondary} disabled={busy} onClick={remove} aria-label={t("deleteLabel", { title: doc.title })}>
              {busy ? t("deleting") : t("delete")}
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {doc.canShare && orgs.length > 0 ? (
        <details className="rounded-xl bg-slate-50 p-3">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-teal-800" aria-label={t("sharingLabel", { title: doc.title })}>
            {t("sharing")}
          </summary>
          <fieldset className="mt-2 space-y-2">
            <legend className="text-sm font-semibold text-slate-900">{t("sharingTitle")}</legend>
            {orgs.map((org) => {
              const shared = doc.sharedWithOrgIds.includes(org.id);
              return (
                <div key={org.id} className="flex flex-wrap items-center justify-between gap-2" id={`${id}-${org.id}`}>
                  <span className="text-sm break-words text-slate-900">{org.name}</span>
                  <button
                    type="button"
                    className={classes.secondary}
                    disabled={busy}
                    onClick={() => (shared ? act("DELETE", `${shareBase}/${org.id}`) : act("POST", shareBase, { org_id: org.id }))}
                  >
                    {shared ? t("stopSharing") : t("share")}
                  </button>
                </div>
              );
            })}
          </fieldset>
        </details>
      ) : null}
    </li>
  );
}

// 023 FR-7/FR-8: a list of documents with `Download`, `Delete` (when allowed), the guardian's per-document
// `Sharing` and the provider's parent-visibility switch.
export function DocumentList({
  documents,
  tone,
  orgs = [],
  label,
}: {
  documents: DocumentView[];
  tone: Tone;
  orgs?: { id: string; name: string }[];
  label: string;
}) {
  const t = useT("documents");
  if (documents.length === 0) return <p className="text-slate-700">{t("empty")}</p>;
  return (
    <ul aria-label={label} className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
      {documents.map((doc) => (
        <DocumentItem key={doc.id} doc={doc} tone={tone} orgs={orgs} />
      ))}
    </ul>
  );
}
