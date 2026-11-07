"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase-browser";

export function SignOutButton() {
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  async function signOut() {
    setSubmitting(true);
    setErrorMessage("");
    const { error } = await supabaseBrowser().auth.signOut();
    if (error) {
      setErrorMessage("Could not sign out. Please try again.");
      setSubmitting(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      {errorMessage ? <span className="text-xs text-red-700">{errorMessage}</span> : null}
      <button
        className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        disabled={submitting}
        onClick={signOut}
        type="button"
      >
        {submitting ? "Signing out..." : "Sign out"}
      </button>
    </div>
  );
}
