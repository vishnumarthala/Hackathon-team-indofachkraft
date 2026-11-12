import { getT } from "@/lib/i18n/server";

export default async function IntakeNotFound() {
  const t = await getT("intake");
  return (
    <div className="mx-auto w-full max-w-md px-4 py-8">
      <h1 className="text-xl font-semibold text-slate-900">{t("invalidTitle")}</h1>
      <p className="mt-2 text-base text-slate-700">{t("invalidText")}</p>
    </div>
  );
}
