"use client";

import { useState } from "react";
import { PhoneOtpForm, secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";
import { supabaseBrowser } from "@/lib/supabase-browser";

type Props = {
  appUrl: string;
  nextPath: string;
  googleEnabled: boolean;
  initialError?: "oauth" | null;
  /** 051 FR-8: Cloudflare Turnstile site key for phone codes (null = no bot check). */
  turnstileSiteKey?: string | null;
};

/** FR-1: Google or phone OTP. Server routes decide where the user lands (FR-3). */
export function FamilyLoginForm({ appUrl, nextPath, googleEnabled, initialError = null, turnstileSiteKey = null }: Props) {
  const t = useT("family.login");
  const [googleError, setGoogleError] = useState(initialError === "oauth");
  const [redirecting, setRedirecting] = useState(false);

  async function continueWithGoogle() {
    setGoogleError(false);
    setRedirecting(true);
    const redirectTo = `${appUrl}/auth/callback?next=${encodeURIComponent(nextPath)}`;
    const { error } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    if (error) {
      setGoogleError(true);
      setRedirecting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <button
          type="button"
          className={`${secondaryButtonClass} min-h-12 w-full gap-3 text-base`}
          disabled={!googleEnabled || redirecting}
          aria-describedby={googleEnabled ? undefined : "google-unavailable"}
          onClick={() => void continueWithGoogle()}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
            <path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6a5.1 5.1 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2Z" />
            <path fill="#34A853" d="M12 23c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.9A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M5.7 14c-.2-.7-.4-1.3-.4-2s.1-1.4.4-2V7.1H2A11 11 0 0 0 2 16.9L5.7 14Z" />
            <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2 7.1L5.7 10C6.6 7.4 9.1 5.4 12 5.4Z" />
          </svg>
          {t("google")}
        </button>
        {googleEnabled ? null : (
          <p id="google-unavailable" className="text-sm text-slate-600">
            {t("googleUnavailable")}
          </p>
        )}
        {googleError ? (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {t("oauthFailed")}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3 text-sm text-slate-500" aria-hidden="true">
        <span className="h-px flex-1 bg-slate-200" />
        {t("or")}
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <PhoneOtpForm
        sendUrl="/api/auth/phone/send"
        verifyUrl="/api/auth/phone/verify"
        verifyExtra={{ next: nextPath }}
        turnstileSiteKey={turnstileSiteKey}
        onVerified={(body) => {
          const target = typeof body.redirect === "string" && body.redirect.startsWith("/") ? body.redirect : "/family";
          window.location.assign(target);
        }}
      />
    </div>
  );
}
