import type { Metadata } from "next";
import Link from "next/link";
import { DisconnectGoogleButton } from "@/components/google/DisconnectGoogleButton";
import { requireProviderPage } from "@/lib/authz";
import { getProviderContext } from "@/lib/booking/store";
import { googleBackend, googleConnectAvailable } from "@/lib/google/client";
import { getConnectionView } from "@/lib/google/connections";
import { getFormatter, getT } from "@/lib/i18n/server";
import { Button } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("integrations");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

const ERRORS = ["state", "denied", "exchange", "no_refresh_token", "scope", "unavailable"] as const;
type Props = { searchParams: Promise<{ connected?: string; disconnected?: string; error?: string }> };

// 037 FR-2: the provider's own Google Calendar connection (profile resolved server-side; never the token).
export default async function IntegrationsPage({ searchParams }: Props) {
  const actor = await requireProviderPage();
  const t = await getT("integrations");
  const format = await getFormatter();
  const sp = await searchParams;
  const ctx = await getProviderContext(actor.user.id);
  const connection = ctx ? await getConnectionView(ctx.profile.id) : null;
  const available = googleConnectAvailable();
  const error = ERRORS.find((e) => e === sp.error) ?? (sp.error ? "generic" : null);
  const banner = error
    ? { tone: "error", text: t(`google.errors.${error}`) }
    : sp.connected
      ? { tone: "ok", text: t("google.connected") }
      : sp.disconnected
        ? { tone: sp.disconnected === "unrevoked" ? "warn" : "ok", text: sp.disconnected === "unrevoked" ? t("google.revokeFailed") : t("google.disconnected") }
        : null;
  const bannerClass = { error: "border-red-200 bg-red-50 text-red-900", warn: "border-amber-200 bg-amber-50 text-amber-900", ok: "border-teal-200 bg-teal-50 text-teal-900" };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <nav aria-label="breadcrumb">
        <Link href="/dashboard/settings" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
          ← {(await getT("notifications"))("settingsTitle")}
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      {banner ? (
        <p role={banner.tone === "error" ? "alert" : "status"} className={`rounded border p-3 text-sm ${bannerClass[banner.tone as keyof typeof bannerClass]}`}>
          {banner.text}
        </p>
      ) : null}
      <section aria-labelledby="google-heading" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 id="google-heading" className="text-lg font-semibold text-slate-900">
          {t("google.title")}
        </h2>
        <p className="text-slate-700">{t("google.intro")}</p>
        <p className="text-sm text-slate-700">{t("google.privacy")}</p>
        <p className="text-sm text-slate-600">{t("google.scribeNote")}</p>
        {googleBackend() === "demo" ? <p role="note" className="rounded bg-violet-50 px-3 py-2 text-sm text-violet-900">{t("google.demo")}</p> : null}
        {!ctx ? (
          <div className="space-y-2">
            <p className="text-slate-700">{t("noProfile")}</p>
            <Link href="/dashboard/profile" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
              {t("openProfile")}
            </Link>
          </div>
        ) : connection ? (
          <div className="space-y-3" data-testid="google-connection">
            <p>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${connection.status === "active" ? "bg-teal-50 text-teal-900" : "bg-amber-50 text-amber-900"}`}>
                {t(`google.status.${connection.status}`)}
              </span>
            </p>
            <p className="break-words text-slate-800">{t("google.connectedAs", { email: connection.google_email })}</p>
            <p className="text-sm text-slate-600">{t("google.connectedOn", { date: format.date(connection.connected_at, "long") })}</p>
            {connection.status !== "active" ? <p role="note" className="rounded bg-amber-50 p-3 text-sm text-amber-900">{t("google.expiredHelp")}</p> : null}
            <div className="flex flex-wrap gap-2">
              {connection.status !== "active" && available ? (
                <Button asChild>
                  <a href="/api/integrations/google/connect">
                    {t("google.reconnect")}
                  </a>
                </Button>
              ) : null}
              <DisconnectGoogleButton />
            </div>
          </div>
        ) : available ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">{t("google.notConnected")}</p>
            <Button asChild>
              <a href="/api/integrations/google/connect">
                {t("google.connect")}
              </a>
            </Button>
          </div>
        ) : (
          <p role="note" className="rounded bg-slate-100 p-3 text-sm text-slate-800">{t("google.unavailable")}</p>
        )}
      </section>
    </div>
  );
}
