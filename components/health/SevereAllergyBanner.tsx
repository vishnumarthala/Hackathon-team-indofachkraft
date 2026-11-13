import { severeAllergies } from "@/lib/health/schema";
import { getT } from "@/lib/i18n/server";
import { getHealthProfile } from "@/lib/queries/health";

// 021 FR-5: shown at the top of the case header when the child has severe allergies. Render only after the
// case access gate (the case layout calls requireCasePage first).
export async function SevereAllergyBanner({ childId }: { childId: string | null }) {
  if (!childId) return null;
  const profile = await getHealthProfile(childId);
  const severe = profile ? severeAllergies(profile) : [];
  if (severe.length === 0) return null;
  const t = await getT("health.provider");
  return (
    <div role="alert" className="mb-3 space-y-1 rounded border border-red-300 bg-red-50 px-4 py-2 text-sm font-semibold text-red-900" data-testid="severe-allergy-banner">
      {severe.map((a, i) => (
        <p key={i} className="break-words">
          {t("severeAllergy", { substance: a.substance })}
        </p>
      ))}
    </div>
  );
}
