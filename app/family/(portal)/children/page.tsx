import Link from "next/link";
import { primaryButtonClass, secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { requireGuardianPage } from "@/lib/authz";
import { listGuardianChildren } from "@/lib/children";
import { ageLabel } from "@/lib/children/age";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 020 FR-11: the guardian's linked children, and the two ways to add one.
export default async function FamilyChildrenPage() {
  const { user } = await requireGuardianPage();
  const t = await getT("family.children");
  const tEmpty = await getT("family.empty");
  const rows = await listGuardianChildren(user.id);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">
          {tEmpty("children")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="children-list">
          {rows.map(({ child }) => (
            <li key={child.id}>
              <Link
                href={`/family/children/${child.id}`}
                aria-label={t("open", { name: child.display_name })}
                className="block min-h-11 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-teal-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
              >
                <span className="block text-lg font-semibold break-words text-slate-900">{child.display_name}</span>
                <span className="block text-sm text-slate-600">{ageLabel(t, child.date_of_birth)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/family/children/new" className={`${primaryButtonClass} sm:w-auto`}>
          {t("add")}
        </Link>
        <Link href="/family/children/claim" className={`${secondaryButtonClass} min-h-12 sm:w-auto`}>
          {t("haveCode")}
        </Link>
      </div>
    </div>
  );
}
