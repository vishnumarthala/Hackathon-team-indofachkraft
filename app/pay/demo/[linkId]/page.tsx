import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoLinkCheckout } from "@/components/fees/DemoLinkCheckout";
import { env } from "@/lib/env";
import { findLinkPayment } from "@/lib/fees/store";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("fees.pay");
  return { title: t("demoTitle"), robots: { index: false } };
}

// 045 DEMO_MODE only: stands in for Razorpay's hosted payment link page (the QR at the desk and the family's `Pay`
// button open it). Public like the real one; it shows the amount and the centre, never the child.
export default async function DemoLinkPage({ params }: { params: Promise<{ linkId: string }> }) {
  if (!env.DEMO_MODE) notFound();
  const { linkId } = await params;
  if (!/^plink_[A-Za-z0-9]{6,40}$/.test(linkId)) notFound();
  const payment = await findLinkPayment(linkId);
  if (!payment || payment.gateway !== "demo") notFound();
  const t = await getT("fees.pay");
  const format = await getFormatter();
  return (
    <div className="mx-auto max-w-md space-y-5 px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-900">{t("demoTitle")}</h1>
      <p className="rounded bg-amber-50 p-3 text-sm text-amber-950">{t("demoNote")}</p>
      <div className="space-y-1 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-700">{t("amount")}</p>
        <p className="text-3xl font-semibold text-slate-900" data-testid="demo-amount">
          {format.inr(payment.amount_paise)}
        </p>
        {payment.description ? <p className="text-slate-800">{payment.description}</p> : null}
        <p className="text-sm text-slate-700">{t("onBehalf", { centre: payment.org_name })}</p>
      </div>
      {payment.status === "created" ? <DemoLinkCheckout linkId={linkId} /> : <p className="text-slate-700">{t("closed")}</p>}
    </div>
  );
}
