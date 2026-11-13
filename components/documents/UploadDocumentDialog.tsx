"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { DOCUMENT_CATEGORIES, FILE_ACCEPT } from "@/lib/documents/constants";
import { useT } from "@/lib/i18n/client";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { runDocumentUpload, type UploadDeps, type UploadErrorKey } from "./uploadFlow";
import { buttonClasses, type Tone } from "./styles";

const deps: UploadDeps = {
  async post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  },
  async uploadToSignedUrl(path, token, file, contentType) {
    const { error } = await supabaseBrowser().storage.from("documents").uploadToSignedUrl(path, token, file, { contentType });
    return { error };
  },
};

const inputClass = "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900";

// 023 FR-7/FR-8: `Upload document` dialog. Guardians tick the organisations that may see the file (`Share with`);
// providers choose `Parent can see this document` (default on). Works from a 375 px phone camera (NFR-2).
export function UploadDocumentDialog({
  endpoint,
  mode,
  orgs = [],
  childName,
  tone,
}: {
  endpoint: string;
  mode: "guardian" | "provider";
  orgs?: { id: string; name: string }[];
  childName?: string;
  tone: Tone;
}) {
  const t = useT("documents");
  const router = useRouter();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UploadErrorKey | null>(null);
  const [done, setDone] = useState(false);
  const classes = buttonClasses(tone);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    setBusy(true);
    setError(null);
    const result = await runDocumentUpload(
      {
        endpoint,
        file: file instanceof File && file.size > 0 ? file : null,
        title: String(data.get("title") ?? ""),
        category: String(data.get("category") ?? ""),
        extra:
          mode === "guardian"
            ? { share_with_org_ids: data.getAll("share_with_org_ids").map(String) }
            : { visible_to_guardian: data.get("visible_to_guardian") === "on" },
      },
      deps,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    form.reset();
    setOpen(false);
    setDone(true);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={classes.primary}
        onClick={() => {
          setDone(false);
          setError(null);
          setOpen(true);
        }}
      >
        {mode === "guardian" ? t("upload") : t("providerUpload")}
      </button>
      {done ? (
        <p role="status" className="text-sm font-medium text-emerald-800">
          {t("uploaded")}
        </p>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        onClose={() => setOpen(false)}
        className="w-[calc(100%-2rem)] max-w-lg rounded-2xl p-0 backdrop:bg-slate-900/50"
      >
        <form onSubmit={submit} className="space-y-4 p-4 sm:p-6" noValidate>
          <h2 id={`${id}-title`} className="text-lg font-semibold text-slate-900">
            {t("uploadTitle")}
          </h2>
          {error ? (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {t(`errors.${error}`)}
            </p>
          ) : null}
          <div>
            <label htmlFor={`${id}-t`} className="block text-sm font-semibold text-slate-900">
              {t("fieldTitle")}
            </label>
            <input id={`${id}-t`} name="title" type="text" maxLength={120} required className={inputClass} />
          </div>
          <div>
            <label htmlFor={`${id}-c`} className="block text-sm font-semibold text-slate-900">
              {t("fieldCategory")}
            </label>
            <select id={`${id}-c`} name="category" required defaultValue="" className={inputClass}>
              <option value="" disabled>
                {t("chooseCategory")}
              </option>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-f`} className="block text-sm font-semibold text-slate-900">
              {t("fieldFile")}
            </label>
            <input
              id={`${id}-f`}
              name="file"
              type="file"
              accept={FILE_ACCEPT}
              required
              aria-describedby={`${id}-fh`}
              className="mt-1 block w-full text-sm text-slate-900 file:mr-3 file:min-h-11 file:rounded-full file:border-0 file:bg-slate-100 file:px-4 file:font-semibold"
            />
            <p id={`${id}-fh`} className="mt-1 text-xs text-slate-600">
              {t("fileHint")}
            </p>
          </div>
          {mode === "guardian" ? (
            <fieldset className="space-y-1">
              <legend className="text-sm font-semibold text-slate-900">{t("shareWith")}</legend>
              {orgs.length === 0 ? (
                <p className="text-sm text-slate-600">{t("noOrgs", { name: childName ?? "" })}</p>
              ) : (
                <>
                  <p className="text-xs text-slate-600">{t("shareWithHint")}</p>
                  {orgs.map((org) => (
                    <div key={org.id} className="flex items-center gap-3">
                      <input id={`${id}-o-${org.id}`} type="checkbox" name="share_with_org_ids" value={org.id} className="h-5 w-5 shrink-0" />
                      <label htmlFor={`${id}-o-${org.id}`} className="min-h-11 content-center text-sm break-words text-slate-900">
                        {org.name}
                      </label>
                    </div>
                  ))}
                </>
              )}
            </fieldset>
          ) : (
            <div className="flex items-center gap-3">
              <input id={`${id}-v`} type="checkbox" name="visible_to_guardian" defaultChecked className="h-5 w-5 shrink-0" />
              <label htmlFor={`${id}-v`} className="min-h-11 content-center text-sm text-slate-900">
                {t("parentCanSee")}
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={classes.primary} disabled={busy}>
              {busy ? t("uploading") : t("save")}
            </button>
            <button type="button" className={classes.secondary} onClick={() => setOpen(false)} disabled={busy}>
              {t("cancel")}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
