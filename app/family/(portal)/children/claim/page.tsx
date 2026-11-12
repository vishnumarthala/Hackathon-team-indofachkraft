import Link from "next/link";
import { ClaimForm } from "@/components/family/children/ClaimForm";
import { requireGuardianPage } from "@/lib/authz";
import { listGuardianChildren } from "@/lib/children";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 020 FR-12: link a clinic record with the therapist's code. Guardians with children choose whether it
// is one of them (the clinic record then joins that child).
export default async function ClaimChildPage() {
  const { user } = await requireGuardianPage();
  const t = await getT("family.children");
  const children = (await listGuardianChildren(user.id)).map(({ child }) => ({ id: child.id, name: child.display_name }));
  return (
    <div className="space-y-6">
      <Link href="/family/children" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("backToList")}
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("claim.title")}</h1>
      <p className="text-slate-700">{t("claim.intro")}</p>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <ClaimForm existingChildren={children} />
      </div>
    </div>
  );
}
