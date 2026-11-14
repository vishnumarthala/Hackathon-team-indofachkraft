import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { canManage, getMembershipRole } from "@/lib/orgs";
import { payoutReadiness } from "@/lib/payouts/store";

// 046 FR-2: "Finish payout setup to accept payments" on the services editor, for organisations of the provider that
// cannot publish paid services yet (payout account not active, or the platform fee not accepted).
export async function PayoutSetupNotice({ userId, orgIds }: { userId: string; orgIds: string[] }) {
  const blocked: { id: string; manage: boolean }[] = [];
  for (const id of orgIds) {
    const r = await payoutReadiness(id);
    if (r.block) blocked.push({ id, manage: canManage(await getMembershipRole(userId, id)) });
  }
  if (!blocked.length) return null;
  const t = await getT("payouts.notice");
  const manager = blocked.find((b) => b.manage);
  return (
    <div role="status" className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900" data-testid="payout-setup-notice">
      <p className="font-semibold">{t("title")}</p>
      <p className="text-sm">{manager ? t("manager") : t("member")}</p>
      {manager ? (
        <Link href={`/dashboard/payouts?org=${manager.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
          {t("link")}
        </Link>
      ) : null}
    </div>
  );
}
