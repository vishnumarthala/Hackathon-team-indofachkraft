import { FamilyEmptyState } from "@/components/family/FamilyEmptyState";
import { requireGuardianPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// Placeholder until a later ticket fills this page (FR-6).
export default async function FamilyMessagesPage() {
  await requireGuardianPage();
  const t = await getT("family");
  return <FamilyEmptyState title={t("shell.messages")} message={t("empty.messages")} />;
}
