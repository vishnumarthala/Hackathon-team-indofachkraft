import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IntakeCall } from "@/components/intake/IntakeCall";
import { enabledVoiceLanguages } from "@/lib/agents/call-language";
import { hasConsent } from "@/lib/consent";
import { getT } from "@/lib/i18n/server";
import { attemptLinkState, getAttemptByToken } from "@/lib/intake/attempts";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("intake.meta");
  return { title: t("title"), robots: { index: false, follow: false } };
}

// Ticket 035 FR-4: the appointment-bound intake page. Child Development services use the existing agent with the
// en/hi/te language choice; other services the generic agent (no language choice; 049: it speaks the page language when
// ELEVENLABS_GENERIC_INTAKE_LANGUAGES has it, else "Voice in English" or skip the call). Expired (appointment
// started), revoked (cancelled, consent withdrawn) and unconsented links show the expired message (fail closed).
export default async function AppointmentIntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const attempt = await getAttemptByToken(token);
  if (!attempt) notFound();
  const t = await getT("intake");
  const state = attemptLinkState(attempt);

  if (state === "completed") {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-8">
        <p className="text-lg font-medium text-slate-900" data-testid="intake-complete">
          {t("complete")}
        </p>
      </div>
    );
  }

  const consented =
    Boolean(attempt.child_id) && (await hasConsent(attempt.child_id as string, "ai_intake_call").catch(() => false));
  if (state !== "active" || !consented) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-8">
        <p className="text-lg font-medium text-slate-900" data-testid="intake-expired">
          {t("appointment.expired")}
        </p>
      </div>
    );
  }

  const child = attempt.child_name ?? "your child";
  const vars = { child, provider: attempt.provider_name };
  const generic = attempt.agent_kind === "generic";
  return (
    <div className="mx-auto w-full max-w-md px-4 py-8" data-agent-kind={attempt.agent_kind}>
      <IntakeCall
        token={token}
        childAlias={child}
        defaultLanguage={generic ? "en" : attempt.case_language}
        apiBase={`/api/intake/a/${encodeURIComponent(token)}`}
        simulatePath={`/api/dev/simulate-intake/a/${encodeURIComponent(token)}`}
        languageSelect={!generic}
        voiceLanguages={generic ? enabledVoiceLanguages("generic_intake") : undefined}
        providerName={attempt.provider_name}
        copy={{
          title: t("appointment.title", vars),
          intro: t(generic ? "appointment.introGeneric" : "appointment.introChildDev", vars),
          consent: t("appointment.consent"),
        }}
      />
    </div>
  );
}
