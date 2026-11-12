"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PhoneOtpForm, secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";
import { supabaseBrowser } from "@/lib/supabase-browser";

export type SignInMethodsView = {
  googleEmail: string | null;
  googleConnected: boolean;
  /** Masked number (`+91 ••••••1234`) or null. */
  phoneMasked: string | null;
  canUnlinkGoogle: boolean;
  canUnlinkPhone: boolean;
};

type Notice = "linked" | "unlinked" | "googleInUse" | "phoneInUse" | "linkFailed" | null;

/** FR-8/FR-9: Google and phone sign-in methods; explicit linking only, never merging accounts. */
export function SignInMethods({
  view,
  appUrl,
  googleEnabled,
  initialNotice,
}: {
  view: SignInMethodsView;
  appUrl: string;
  googleEnabled: boolean;
  initialNotice: Notice;
}) {
  const t = useT("family.settings");
  const tErrors = useT("errors");
  const router = useRouter();
  const [addingPhone, setAddingPhone] = useState(false);
  const [notice, setNotice] = useState<Notice>(initialNotice);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function connectGoogle() {
    setBusy(true);
    setNotice(null);
    const redirectTo = `${appUrl}/auth/callback?flow=link&next=${encodeURIComponent("/family/settings")}`;
    const { error } = await supabaseBrowser().auth.linkIdentity({ provider: "google", options: { redirectTo } });
    if (error) {
      setNotice("linkFailed");
      setBusy(false);
    }
  }

  async function unlink(provider: "google" | "phone") {
    setBusy(true);
    setNotice(null);
    setFailed(false);
    try {
      const res = await fetch("/api/family/identities", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setNotice("unlinked");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const unlinkButton = (provider: "google" | "phone", allowed: boolean) => (
    <>
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={!allowed || busy}
        title={allowed ? undefined : t("unlinkDisabled")}
        aria-describedby={allowed ? undefined : `unlink-${provider}-why`}
        onClick={() => void unlink(provider)}
      >
        {t("unlink")}
      </button>
      {allowed ? null : (
        <span id={`unlink-${provider}-why`} className="sr-only">
          {t("unlinkDisabled")}
        </span>
      )}
    </>
  );

  const noticeText = notice ? t(notice) : "";
  const noticeIsError = notice === "googleInUse" || notice === "phoneInUse" || notice === "linkFailed";

  return (
    <div className="space-y-4">
      {noticeText ? (
        <p
          role={noticeIsError ? "alert" : "status"}
          className={`rounded-xl px-4 py-3 text-sm font-medium ${noticeIsError ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-900"}`}
        >
          {noticeText}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {tErrors("generic")}
        </p>
      ) : null}

      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
        <li className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="font-semibold text-slate-900">{t("google")}</p>
            <p className="break-all text-sm text-slate-600">
              {view.googleConnected
                ? view.googleEmail
                  ? t("connectedAs", { email: view.googleEmail })
                  : t("connected")
                : t("notConnected")}
            </p>
          </div>
          {view.googleConnected ? (
            unlinkButton("google", view.canUnlinkGoogle)
          ) : (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={!googleEnabled || busy}
              onClick={() => void connectGoogle()}
            >
              {t("connectGoogle")}
            </button>
          )}
        </li>
        <li className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">{t("phone")}</p>
              <p className="text-sm text-slate-600">{view.phoneMasked ?? t("notConnected")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {addingPhone ? null : (
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={busy}
                  onClick={() => {
                    setNotice(null);
                    setAddingPhone(true);
                  }}
                >
                  {view.phoneMasked ? t("changePhone") : t("addPhone")}
                </button>
              )}
              {view.phoneMasked ? unlinkButton("phone", view.canUnlinkPhone) : null}
            </div>
          </div>
          {addingPhone ? (
            <PhoneOtpForm
              sendUrl="/api/family/identities/phone"
              verifyUrl="/api/family/identities/phone/verify"
              onCancel={() => setAddingPhone(false)}
              onVerified={() => {
                setAddingPhone(false);
                setNotice("linked");
                router.refresh();
              }}
            />
          ) : null}
        </li>
      </ul>
    </div>
  );
}
