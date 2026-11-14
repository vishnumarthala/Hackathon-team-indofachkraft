import Link from "next/link";
import { getT } from "@/lib/i18n/server";

// 046: members who are not owner/admin get a 403 for /dashboard/payouts (forbidden(), next.config authInterrupts).
export default async function PayoutsForbidden() {
  const t = await getT("payouts.dashboard");
  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <p className="text-slate-700" data-testid="payouts-forbidden">{t("forbidden")}</p>
      <Link href="/dashboard" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
        DoctorNearMe
      </Link>
    </div>
  );
}
