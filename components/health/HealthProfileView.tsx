import type { ReactNode } from "react";
import { getT } from "@/lib/i18n/server";
import { hasNoKnownAllergies, listedAllergies, type HealthProfile, type HealthSection } from "@/lib/health/schema";

// 021 FR-5/FR-6: read-only profile (provider Health tab, guardian's past versions). Free text as entered (NFR-2).
export async function HealthProfileView({ profile }: { profile: HealthProfile }) {
  const [t, ts, tf, tsev] = await Promise.all([
    getT("health"),
    getT("health.sections"),
    getT("health.fields"),
    getT("health.severity"),
  ]);
  const allergies = listedAllergies(profile);
  const empty = <p className="text-sm text-slate-600">{t("notRecorded")}</p>;

  const block = (name: HealthSection, body: ReactNode) => (
    <section key={name} aria-labelledby={`health-${name}`} className="space-y-2 rounded border border-slate-200 bg-white p-4" data-section={name}>
      <h3 id={`health-${name}`} className="text-base font-semibold text-slate-900">
        {ts(name)}
      </h3>
      {body}
    </section>
  );

  return (
    <div className="space-y-4">
      {block(
        "allergies",
        hasNoKnownAllergies(profile) ? (
          <p className="text-slate-900">{t("nka")}</p>
        ) : allergies.length === 0 ? (
          empty
        ) : (
          <ul className="space-y-1">
            {allergies.map((a, i) => (
              <li key={i} className="break-words text-slate-900">
                <span className={a.severity === "severe" ? "font-semibold text-red-800" : "font-medium"}>{a.substance}</span>
                <span className="text-slate-700">
                  {" - "}
                  {tf("severity")}: {tsev(a.severity)}
                  {a.reaction ? `; ${tf("reaction")}: ${a.reaction}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ),
      )}
      {block(
        "medications",
        profile.medications.length === 0 ? (
          empty
        ) : (
          <ul className="space-y-1">
            {profile.medications.map((m, i) => (
              <li key={i} className="break-words text-slate-900">
                <span className="font-medium">{m.name}</span>
                {[m.dose, m.frequency].filter(Boolean).length > 0 ? ` ${[m.dose, m.frequency].filter(Boolean).join(", ")}` : ""}
                {m.since ? <span className="text-slate-700"> ({tf("since")}: {m.since})</span> : null}
              </li>
            ))}
          </ul>
        ),
      )}
      {block(
        "conditions",
        profile.conditions.length === 0 ? (
          empty
        ) : (
          <ul className="space-y-1">
            {profile.conditions.map((c, i) => (
              <li key={i} className="break-words text-slate-900">
                <span className="font-medium">{c.name}</span>
                {c.since ? <span className="text-slate-700"> ({tf("since")}: {c.since})</span> : null}
                {c.notes ? <p className="text-sm whitespace-pre-line text-slate-700">{c.notes}</p> : null}
              </li>
            ))}
          </ul>
        ),
      )}
      {block("birth_history", profile.birth_history ? <p className="break-words whitespace-pre-line text-slate-900">{profile.birth_history}</p> : empty)}
      {block(
        "developmental_history",
        profile.developmental_history ? <p className="break-words whitespace-pre-line text-slate-900">{profile.developmental_history}</p> : empty,
      )}
      {block(
        "emergency_contact",
        profile.emergency_contact_name || profile.emergency_contact_phone ? (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-slate-900 sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-slate-700">{tf("contactName")}</dt>
            <dd className="break-words">{profile.emergency_contact_name ?? "-"}</dd>
            <dt className="font-medium text-slate-700">{tf("contactPhone")}</dt>
            <dd>{profile.emergency_contact_phone ? <a href={`tel:${profile.emergency_contact_phone}`} className="underline">{profile.emergency_contact_phone}</a> : "-"}</dd>
          </dl>
        ) : (
          empty
        ),
      )}
      {block(
        "blood_group",
        profile.blood_group ? (
          <p className="text-slate-900">{profile.blood_group === "unknown" ? t("bloodGroupUnknown") : profile.blood_group}</p>
        ) : (
          empty
        ),
      )}
    </div>
  );
}
