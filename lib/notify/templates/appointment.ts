// 030 appointment templates. Content (FR-6): provider name, date/time in the clinic's (video: the provider's) time
// zone with its abbreviation, mode and location. Never the child's name or anything clinical. Confirmations and
// reschedules carry an .ics REQUEST, cancellations a CANCEL (same UID per reschedule chain: the event's aggregate).
// WhatsApp keeps the project's Meta format: one body parameter, the app link (docs/notifications.md).
// 035: confirmations (and reschedules) tell the guardian about the pre-consult intake (payload `intake`): the
// appointment-bound call link, or how to allow the call. WhatsApp confirmations then use the `_intake` /
// `_allow_intake` template variants (docs/notifications.md).
import { intakeAttemptUrl } from "@/lib/intake/attempt-token";
import { formatDateTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";
import type { Template, TemplateContext } from "../types";
import { defineTemplate, roleLink, type TemplateStrings } from "./shared";

export type AppointmentPayload = {
  appointment_id: string;
  starts_at: string;
  ends_at: string;
  provider_name: string;
  mode: "in_clinic" | "video";
  time_zone: string;
  location?: string | null;
  cancelled_by?: "guardian" | "provider" | "system";
  intake?: { status: "link"; attempt_id: string; agent_kind: string } | { status: "consent_needed"; agent_kind: string };
  intake_attempt_id?: string;
};

export type AppointmentValues = { provider: string; when: string; where: string; role: "guardian" | "provider" };

const WHERE: Record<Locale, { video: string; clinic: (location: string) => string; clinicUnknown: string }> = {
  en: { video: "Video consultation", clinic: (l) => `In clinic: ${l}`, clinicUnknown: "In clinic" },
  hi: { video: "वीडियो परामर्श", clinic: (l) => `क्लिनिक में: ${l}`, clinicUnknown: "क्लिनिक में" },
  te: { video: "వీడియో సంప్రదింపు", clinic: (l) => `క్లినిక్‌లో: ${l}`, clinicUnknown: "క్లినిక్‌లో" },
};

function safeWhen(payload: AppointmentPayload, locale: Locale): string {
  try {
    return formatDateTime(payload.starts_at, locale, payload.time_zone);
  } catch {
    return formatDateTime(payload.starts_at, locale, "Asia/Kolkata");
  }
}

export function appointmentValues(ctx: TemplateContext<AppointmentPayload>): AppointmentValues {
  const p = ctx.payload;
  const w = WHERE[ctx.locale] ?? WHERE.en;
  return {
    provider: p.provider_name,
    when: safeWhen(p, ctx.locale),
    where: p.mode === "video" ? w.video : p.location ? w.clinic(p.location) : w.clinicUnknown,
    role: ctx.role === "guardian" ? "guardian" : "provider",
  };
}

type Strings = Record<Locale, (v: AppointmentValues) => TemplateStrings>;

// 035 FR-3 (exact English wording from the ticket; hi/te drafts await native review with docs/notifications.md).
export const INTAKE_TEXT: Record<Locale, { link: (url: string) => string; consent: string }> = {
  en: {
    link: (url) => `Before your visit, please take a short voice call with our AI assistant: ${url}`,
    consent: "Allow the AI intake call in your DoctorNearMe app to prepare for this visit.",
  },
  hi: {
    link: (url) => `मुलाक़ात से पहले, कृपया हमारे AI सहायक के साथ एक छोटी वॉइस कॉल करें: ${url}`,
    consent: "इस मुलाक़ात की तैयारी के लिए अपने DoctorNearMe ऐप में AI इनटेक कॉल की अनुमति दें।",
  },
  te: {
    link: (url) => `మీ సందర్శనకు ముందు, దయచేసి మా AI సహాయకుడితో ఒక చిన్న వాయిస్ కాల్ చేయండి: ${url}`,
    consent: "ఈ సందర్శనకు సిద్ధం కావడానికి మీ DoctorNearMe యాప్‌లో AI ఇన్‌టేక్ కాల్‌ను అనుమతించండి.",
  },
};

/** The intake sentence for this recipient (guardians only), and the call URL when there is a link. */
export function intakeSentence(ctx: TemplateContext<AppointmentPayload>): { text: string; url: string | null } | null {
  if (ctx.role !== "guardian") return null;
  const text = INTAKE_TEXT[ctx.locale] ?? INTAKE_TEXT.en;
  const attemptId = ctx.payload.intake?.status === "link" ? ctx.payload.intake.attempt_id : ctx.payload.intake_attempt_id;
  if (attemptId) {
    const url = intakeAttemptUrl(ctx.appUrl, attemptId);
    return { text: text.link(url), url };
  }
  if (ctx.payload.intake?.status === "consent_needed") return { text: text.consent, url: null };
  return null;
}

type IntakeOption = { intake?: boolean; whatsappIntakeVariants?: boolean };

export function appointmentTemplate(
  name: string,
  strings: Strings,
  ics?: "REQUEST" | "CANCEL",
  opts: IntakeOption = {},
): Template<AppointmentPayload> {
  return {
    name,
    render(ctx) {
      const v = appointmentValues(ctx);
      const intake = opts.intake ? intakeSentence(ctx) : null;
      const withIntake = (s: TemplateStrings): TemplateStrings => (intake ? { ...s, body: `${s.body} ${intake.text}` } : s);
      const rendered = defineTemplate<AppointmentPayload>({
        name,
        strings: { en: withIntake(strings.en(v)), hi: withIntake(strings.hi(v)), te: withIntake(strings.te(v)) },
        link: (c) => roleLink(c, "/family/appointments", "/dashboard/schedule"),
        ics: ics
          ? ({ payload }) => ({
              method: ics,
              start: payload.starts_at,
              end: payload.ends_at,
              summary: `Appointment with ${payload.provider_name} (DoctorNearMe)`,
              description: v.where,
              ...(payload.mode === "in_clinic" && payload.location ? { location: payload.location } : {}),
            })
          : undefined,
      }).render(ctx);
      if (intake && opts.whatsappIntakeVariants && rendered.whatsapp) {
        rendered.whatsapp = intake.url
          ? { ...rendered.whatsapp, name: `${name}_intake`, params: [...rendered.whatsapp.params, intake.url] }
          : { ...rendered.whatsapp, name: `${name}_allow_intake` };
      }
      return rendered;
    },
  };
}
