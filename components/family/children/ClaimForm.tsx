"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { DeclarationCheckbox, RelationshipSelect } from "@/components/family/children/AddChildForm";
import { inputClass, primaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";

type ErrorKey = "invalid" | "tooMany" | "conflict" | "relationship" | "declaration" | "failed";

/** Maps the API answer (English contract) to a translated message key. */
export function claimErrorKey(status: number): ErrorKey {
  if (status === 404) return "invalid";
  if (status === 429) return "tooMany";
  if (status === 409) return "conflict";
  return "failed";
}

// 020 FR-12: code + relationship + declaration; with existing children, "Is this one of your children?".
export function ClaimForm({ existingChildren }: { existingChildren: { id: string; name: string }[] }) {
  const t = useT("family.children");
  const router = useRouter();
  const id = useId();
  const [code, setCode] = useState("");
  const [relationship, setRelationship] = useState("");
  const [declaration, setDeclaration] = useState(false);
  const [target, setTarget] = useState<string>("new");
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!relationship) return setError("relationship");
    if (!declaration) return setError("declaration");
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/family/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          relationship,
          declaration: true,
          existing_child_id: target === "new" ? null : target,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { child?: { id: string } };
      if (res.status === 201 && body.child) {
        router.push(`/family/children/${body.child.id}`);
        router.refresh();
        return;
      }
      setError(res.status === 400 ? "invalid" : claimErrorKey(res.status));
    } catch {
      setError("failed");
    }
    setSaving(false);
  }

  const message =
    error === "invalid"
      ? t("claim.invalid")
      : error === "tooMany"
        ? t("claim.tooMany")
        : error === "conflict"
          ? t("claim.conflict")
          : error === "relationship"
            ? t("form.relationshipError")
            : error === "declaration"
              ? t("form.declarationError")
              : error === "failed"
                ? t("form.saveFailed")
                : null;

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="space-y-2">
        <label htmlFor={`${id}-code`} className="block text-sm font-semibold text-slate-900">
          {t("claim.code")}
        </label>
        <input
          id={`${id}-code`}
          className={`${inputClass} font-mono uppercase tracking-widest`}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-describedby={`${id}-code-hint`}
        />
        <p id={`${id}-code-hint`} className="text-sm text-slate-600">
          {t("claim.codeHint")}
        </p>
      </div>
      {existingChildren.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-slate-900">{t("claim.existingQuestion")}</legend>
          {existingChildren.map((c) => (
            <label key={c.id} className="flex min-h-11 items-center gap-3 text-base text-slate-900">
              <input type="radio" name={`${id}-target`} value={c.id} checked={target === c.id} onChange={() => setTarget(c.id)} />
              <span className="break-words">{c.name}</span>
            </label>
          ))}
          <label className="flex min-h-11 items-center gap-3 text-base text-slate-900">
            <input type="radio" name={`${id}-target`} value="new" checked={target === "new"} onChange={() => setTarget("new")} />
            {t("claim.newChild")}
          </label>
        </fieldset>
      ) : null}
      <RelationshipSelect id={`${id}-rel`} value={relationship} onChange={setRelationship} invalid={error === "relationship"} />
      <DeclarationCheckbox id={`${id}-decl`} checked={declaration} onChange={setDeclaration} />
      {message ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {message}
        </p>
      ) : null}
      <button type="submit" className={`${primaryButtonClass} sm:w-auto`} disabled={saving}>
        {saving ? t("claim.saving") : t("claim.submit")}
      </button>
    </form>
  );
}
