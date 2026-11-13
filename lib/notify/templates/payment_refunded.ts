// 031: a payment was refunded (in-app + email, no WhatsApp template yet). No child name, no amounts in email text.
// FR-6 wording when the time was no longer available after a late payment.
import type { Locale } from "@/lib/i18n/config";
import type { Template } from "../types";
import { defineTemplate, type TemplateStrings } from "./shared";

type Payload = { payment_id: string; appointment_id: string; reason: string };

const STRINGS: Record<Locale, { title: string; unavailable: string; cancelled: string; other: string }> = {
  en: {
    title: "Payment refunded",
    unavailable: "Your payment was refunded because the time was no longer available.",
    cancelled: "Your payment was refunded because the appointment was cancelled.",
    other: "Your payment for an appointment was refunded.",
  },
  hi: {
    title: "भुगतान वापस किया गया",
    unavailable: "आपका भुगतान वापस कर दिया गया क्योंकि वह समय अब उपलब्ध नहीं था।",
    cancelled: "आपका भुगतान वापस कर दिया गया क्योंकि अपॉइंटमेंट रद्द हो गया।",
    other: "अपॉइंटमेंट के लिए आपका भुगतान वापस कर दिया गया।",
  },
  te: {
    title: "చెల్లింపు తిరిగి ఇవ్వబడింది",
    unavailable: "ఆ సమయం ఇక అందుబాటులో లేనందున మీ చెల్లింపు తిరిగి ఇవ్వబడింది.",
    cancelled: "అపాయింట్‌మెంట్ రద్దయినందున మీ చెల్లింపు తిరిగి ఇవ్వబడింది.",
    other: "అపాయింట్‌మెంట్ కోసం మీ చెల్లింపు తిరిగి ఇవ్వబడింది.",
  },
};

function stringsFor(locale: Locale, reason: string): TemplateStrings {
  const s = STRINGS[locale] ?? STRINGS.en;
  const body =
    reason === "slot_unavailable"
      ? s.unavailable
      : ["appointment_cancelled", "provider_cancelled", "guardian_cancelled", "system_cancelled"].includes(reason)
        ? s.cancelled
        : s.other;
  return { title: s.title, body };
}

const template: Template<Payload> = {
  name: "payment_refunded",
  render(ctx) {
    const reason = ctx.payload.reason;
    return defineTemplate<Payload>({
      name: "payment_refunded",
      whatsapp: false,
      strings: { en: stringsFor("en", reason), hi: stringsFor("hi", reason), te: stringsFor("te", reason) },
      link: () => "/family/appointments",
    }).render(ctx);
  },
};

export default template;
