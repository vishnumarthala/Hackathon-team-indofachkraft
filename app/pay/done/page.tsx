import type { Metadata } from "next";
import Link from "next/link";
import { RECEIPT_PATTERN } from "@/lib/fees/money";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("fees.pay");
  return { title: t("doneTitle"), robots: { index: false } };
}

// 045: where the payment link redirect lands for someone who is not the child's signed-in guardian (e.g. a phone at the
// desk). No names; the receipt number only.
export default async function PayDonePage({ searchParams }: { searchParams: Promise<{ state?: string; receipt?: string }> }) {
  const t = await getT("fees.pay");
  const { state, receipt } = await searchParams;
  const text = state === "paid" ? t("paid") : state === "failed" ? t("doneFailed") : state === "invalid" ? t("doneInvalid") : t("doneError");
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-10">
      <h1 className="text-2xl font-bold text-slate-900">{t("doneTitle")}</h1>
      <p role="status" className="text-lg text-slate-900" data-testid="pay-done">
        {text}
      </p>
      {state === "paid" && receipt && RECEIPT_PATTERN.test(receipt) ? <p className="text-slate-700">{t("receiptNumber", { number: receipt })}</p> : null}
      <Link href="/family" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
        {t("openApp")}
      </Link>
    </div>
  );
}
