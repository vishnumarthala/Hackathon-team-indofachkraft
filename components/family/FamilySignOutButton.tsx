"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { supabaseBrowser } from "@/lib/supabase-browser";

export function FamilySignOutButton() {
  const t = useT("family.shell");
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  async function signOut() {
    setSubmitting(true);
    setFailed(false);
    const { error } = await supabaseBrowser().auth.signOut();
    if (error) {
      setFailed(true);
      setSubmitting(false);
      return;
    }
    router.replace("/family/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {failed ? (
        <span role="alert" className="text-xs text-red-700">
          {t("signOutFailed")}
        </span>
      ) : null}
      <button
        className="min-h-11 cursor-pointer rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        disabled={submitting}
        onClick={() => void signOut()}
        type="button"
      >
        {submitting ? t("signingOut") : t("signOut")}
      </button>
    </div>
  );
}
