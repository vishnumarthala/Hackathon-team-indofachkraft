// 030 appointment templates. Content (FR-6): provider name, date/time in the clinic's (video: the provider's) time
// zone with its abbreviation, mode and location. Never the child's name or anything clinical. Confirmations and
// reschedules carry an .ics REQUEST, cancellations a CANCEL (same UID per reschedule chain: the event's aggregate).
// WhatsApp keeps the project's Meta format: one body parameter, the app link (docs/notifications.md).
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

export function appointmentTemplate(name: string, strings: Strings, ics?: "REQUEST" | "CANCEL"): Template<AppointmentPayload> {
  return {
    name,
    render(ctx) {
      const v = appointmentValues(ctx);
      return defineTemplate<AppointmentPayload>({
        name,
        strings: { en: strings.en(v), hi: strings.hi(v), te: strings.te(v) },
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
    },
  };
}
