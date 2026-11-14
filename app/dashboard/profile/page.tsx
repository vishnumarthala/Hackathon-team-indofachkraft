import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ListingToggle,
  LocationsPanel,
  OrgPublicForm,
  PhotoForm,
  ProfileForm,
  VerificationForm,
} from "@/components/providers/ProfileEditor";
import { getUserRole, requirePageUser } from "@/lib/auth";
import { getFormatter, getT } from "@/lib/i18n/server";
import { canManage } from "@/lib/orgs";
import { getProfileByUserId, listProfileLocations, listUserOrgsWithLocations, photoUrl } from "@/lib/providers";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("providers.editor");
  return { title: t("metaTitle") };
}

const STATUS_TONE = {
  unverified: "neutral",
  pending: "warning",
  verified: "brand",
  rejected: "danger",
  suspended: "danger",
} as const satisfies Record<string, BadgeTone>;

function Section({ title, children, intro }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      {intro ? <p className="text-sm text-slate-700">{intro}</p> : null}
      {children}
    </section>
  );
}

// FR-3 owner profile editor. Only the signed-in provider's own profile is ever loaded here.
export default async function ProfileEditorPage() {
  const user = await requirePageUser();
  if ((await getUserRole(user.id)) === "guardian") redirect("/family");

  const t = await getT("providers");
  const format = await getFormatter();
  const profile = await getProfileByUserId(user.id);

  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6">
        <h1 className="text-2xl font-semibold">{t("editor.title")}</h1>
        <p className="text-slate-700">{t("editor.noProfile")}</p>
        <Link href="/join" className="font-medium text-slate-900 underline">
          {t("editor.createOne")}
        </Link>
      </div>
    );
  }

  const [linked, orgs] = await Promise.all([listProfileLocations(profile.id), listUserOrgsWithLocations(user.id)]);
  const status = profile.verification_status;
  const statusInfo = {
    unverified: t("verification.unverifiedInfo"),
    pending: t("verification.pendingInfo"),
    verified: t("verification.verifiedInfo", { date: profile.verified_at ? format.date(profile.verified_at, "long") : "" }),
    rejected: t("verification.rejectedInfo"),
    suspended: t("verification.suspendedInfo"),
  }[status];
  const toView = (
    loc: { id: string; name: string; address_line1: string; locality: string; city: string; pincode: string; lat: number | null; lng: number | null },
    orgName: string,
  ) => ({
    id: loc.id,
    name: loc.name,
    address_line1: loc.address_line1,
    locality: loc.locality,
    city: loc.city,
    pincode: loc.pincode,
    orgName,
    mapped: loc.lat !== null && loc.lng !== null,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">{t("editor.title")}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-700">{t("editor.statusLabel")}:</span>
          <Badge tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Badge>
          {profile.is_synthetic ? <span className="rounded bg-violet-100 px-2 py-0.5 font-medium text-violet-900">{t("demoBadge")}</span> : null}
          {profile.listed ? (
            <Link href={`/p/${profile.slug}`} className="font-medium text-slate-900 underline">
              {t("editor.viewPublic")}
            </Link>
          ) : null}
        </p>
        <ListingToggle profileId={profile.id} listed={profile.listed} status={status} />
      </header>

      <Section title={t("editor.details")}>
        <ProfileForm
          verified={status === "verified"}
          profile={{
            id: profile.id,
            display_name: profile.display_name,
            provider_type: profile.provider_type,
            qualifications: profile.qualifications,
            bio: profile.bio,
            languages: profile.languages,
            years_experience: profile.years_experience,
            time_zone: profile.time_zone,
            offers_in_clinic: profile.offers_in_clinic,
            offers_video: profile.offers_video,
          }}
        />
      </Section>

      <Section title={t("photo.title")}>
        <PhotoForm profileId={profile.id} photoUrl={photoUrl(profile.photo_path)} name={profile.display_name} />
      </Section>

      <Section title={t("locations.title")} intro={t("locations.hint")}>
        <LocationsPanel
          profileId={profile.id}
          linked={linked.map((loc) => toView(loc, loc.org.public_name ?? loc.org.name))}
          orgs={orgs.map((o) => ({
            id: o.id,
            name: o.public_name ?? o.name,
            canManage: canManage(o.org_role),
            locations: o.locations.map((loc) => toView(loc, o.public_name ?? o.name)),
          }))}
        />
      </Section>

      <Section title={t("verification.title")} intro={t("verification.intro")}>
        <p role="status" className="rounded bg-slate-50 px-3 py-2 text-sm text-slate-800">
          {statusInfo}
        </p>
        {profile.registration_council && profile.registration_number ? (
          <p className="text-sm text-slate-700">
            {t("verification.current", {
              council: t(`councils.${profile.registration_council as "NMC" | "STATE_MEDICAL_COUNCIL" | "RCI" | "OTHER"}`),
              number: profile.registration_number,
            })}
          </p>
        ) : null}
        <VerificationForm profileId={profile.id} status={status} hasRegistration={Boolean(profile.registration_number)} />
      </Section>

      {orgs
        .filter((o) => canManage(o.org_role))
        .map((o) => (
          <section key={o.id} className="rounded border border-slate-200 bg-white p-4">
            <OrgPublicForm
              org={{
                id: o.id,
                name: o.name,
                public_name: o.public_name,
                about: o.about,
                phone_public: o.phone_public,
                website: o.website,
                listed: o.listed,
              }}
            />
          </section>
        ))}
    </div>
  );
}
