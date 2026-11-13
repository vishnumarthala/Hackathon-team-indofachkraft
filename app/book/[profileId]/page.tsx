import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookingFlow, type FlowHold } from "@/components/booking/BookingFlow";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { currentBookingSessionHash } from "@/lib/booking/session";
import { getBookableProfile, getOwnedHold, listServices } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { ageLabel } from "@/lib/children/age";
import { listGuardianChildren } from "@/lib/children";
import { hasGoogleIdentity } from "@/lib/google/meet";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ profileId: string }>; searchParams: Promise<{ hold?: string; appointment?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { profileId } = await params;
  const profile = isUuid(profileId) ? await getBookableProfile(profileId) : null;
  const t = await getT("booking");
  return { title: profile ? `${t("flow.metaTitle", { name: profile.display_name })} | DoctorNearMe` : "DoctorNearMe", robots: { index: false, follow: false } };
}

// FR-7 public booking page (`Book` on /p/<slug>). Only verified + listed profiles with active services; anyone can
// pick a time and hold it; confirming needs a signed-in guardian (hold attached after sign-in via ?hold=<id>).
// No third-party scripts (family CSP in proxy.ts, lib/csp.ts).
export default async function BookPage({ params, searchParams }: Props) {
  const { profileId } = await params;
  // 034: the voice booking widget links here with `?appointment=<id>` (same meaning as `?hold=`).
  const { hold, appointment } = await searchParams;
  const holdParam = hold ?? appointment;
  if (!isUuid(profileId)) notFound();
  const profile = await getBookableProfile(profileId);
  if (!profile) notFound();
  const t = await getT("booking");
  const tp = await getT("providers");
  const tc = await getT("family.children");
  const services = await listServices(profile.id, { activeOnly: true });

  const user = await getAuthenticatedUser();
  const role = user ? await getUserRole(user.id) : null;
  const isGuardian = role === "guardian";
  const children = user && isGuardian ? await listGuardianChildren(user.id) : [];
  // 037 FR-5a: video services need a linked Google account (checked again by the hold/confirm routes).
  const hasGoogle = user && isGuardian ? await hasGoogleIdentity(user.id) : false;

  let initialHold: FlowHold | null = null;
  if (holdParam && isUuid(holdParam)) {
    const held = await getOwnedHold(holdParam, { userId: user?.id ?? null, sessionHash: await currentBookingSessionHash() });
    if (held && held.status === "held" && held.provider_profile_id === profile.id && held.hold_expires_at) {
      initialHold = { id: held.id, serviceId: held.service_id, start: held.starts_at, end: held.ends_at, expiresAt: held.hold_expires_at };
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-6 sm:py-8">
      <Link href={`/p/${profile.slug}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("flow.backToProfile")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("flow.title")}</h1>
        <p className="text-lg text-slate-700">{t("flow.with", { name: profile.display_name })}</p>
      </header>
      {profile.is_synthetic ? (
        <p role="note" className="rounded bg-violet-50 px-3 py-2 text-sm text-violet-900">
          {tp("public.demoNote")}
        </p>
      ) : null}
      <BookingFlow
        profile={{ id: profile.id, name: profile.display_name, slug: profile.slug, demo: profile.is_synthetic }}
        services={services.map((s) => ({
          id: s.id,
          name: s.name,
          mode: s.mode,
          duration_min: s.duration_min,
          fee_inr: s.fee_inr,
          payment_mode: s.payment_mode,
          location_name: s.location_name,
          location_address: s.location_address,
          time_zone: s.time_zone,
        }))}
        viewer={{
          signedIn: Boolean(user),
          isGuardian,
          hasGoogle,
          children: children.map(({ child }) => ({ id: child.id, name: child.display_name, age: ageLabel(tc, child.date_of_birth) })),
        }}
        initialHold={initialHold}
      />
    </div>
  );
}
