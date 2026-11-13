import Link from "next/link";
import { AddChildForm } from "@/components/family/children/AddChildForm";
import { isBookingPath, safeRelativePath } from "@/lib/auth-access";
import { requireGuardianPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 020 FR-11: add a child (creates the child and an active self-registered link).
export default async function AddChildPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await requireGuardianPage();
  // 030: "Add a child" from the booking flow returns there.
  const requested = safeRelativePath((await searchParams).next);
  const next = requested && isBookingPath(requested.split(/[?#]/)[0]) ? requested : undefined;
  const t = await getT("family.children");
  return (
    <div className="space-y-6">
      <Link href="/family/children" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("backToList")}
      </Link>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("form.title")}</h1>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <AddChildForm next={next} />
      </div>
    </div>
  );
}
