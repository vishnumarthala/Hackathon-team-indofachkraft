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

// 052 FR-6: the confirmation tells the guardian what happens next, in the same order as the app's timeline
// (lib/family/journey.ts): Permissions -> Intake call (only when the service has one) -> Visit -> Home program.
// Plain text; nothing clinical, no child name (D-5).
export const NEXT_STEPS_TEXT: Record<Locale, { intro: string; permissions: string; intake: string; visit: (when: string) => string; home: string }> = {
  en: {
    intro: "What happens next:",
    permissions: "Permissions: check them in your DoctorNearMe app.",
    intake: "Intake call: a short voice call before the visit.",
    visit: (when) => `Visit: ${when}.`,
    home: "Home program: after the visit, activities to practise at home.",
  },
  hi: {
    intro: "आगे क्या होगा:",
    permissions: "अनुमतियाँ: अपने DoctorNearMe ऐप में देख लें।",
    intake: "इनटेक कॉल: मुलाक़ात से पहले एक छोटी वॉइस कॉल।",
    visit: (when) => `मुलाक़ात: ${when}।`,
    home: "होम प्रोग्राम: मुलाक़ात के बाद, घर पर अभ्यास की गतिविधियाँ।",
  },
  te: {
    intro: "తర్వాత ఏమి జరుగుతుంది:",
    permissions: "అనుమతులు: మీ DoctorNearMe యాప్‌లో చూసుకోండి.",
    intake: "ఇన్‌టేక్ కాల్: సందర్శనకు ముందు ఒక చిన్న వాయిస్ కాల్.",
    visit: (when) => `సందర్శన: ${when}.`,
    home: "హోమ్ ప్రోగ్రామ్: సందర్శన తర్వాత, ఇంట్లో సాధన చేయాల్సిన కార్యకలాపాలు.",
  },
};

/** The numbered steps for a guardian's confirmation (null for providers). */
export function nextStepsSentence(ctx: TemplateContext<AppointmentPayload>, when: string): string | null {
  if (ctx.role !== "guardian") return null;
  const text = NEXT_STEPS_TEXT[ctx.locale] ?? NEXT_STEPS_TEXT.en;
  const steps = [text.permissions, ...(ctx.payload.intake ? [text.intake] : []), text.visit(when), text.home];
  return `${text.intro} ${steps.map((step, i) => `${i + 1}. ${step}`).join(" ")}`;
}

type IntakeOption = { intake?: boolean; whatsappIntakeVariants?: boolean; nextSteps?: boolean };

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
      const steps = opts.nextSteps ? nextStepsSentence(ctx, v.when) : null;
      const withIntake = (s: TemplateStrings): TemplateStrings => {
        const body = [s.body, intake?.text, steps].filter(Boolean).join(" ");
        return { ...s, body };
      };
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
