// 035 FR-3: the appointment-bound intake link, sent when the guardian allows the AI intake call after booking.
// In-app and email carry the call link; WhatsApp `appointment_intake_link` keeps the project format ({{1}} = the app
// page, /family/appointments, which shows the `take the call` button).
import { appointmentTemplate } from "./appointment";

export default appointmentTemplate(
  "appointment_intake_link",
  {
    en: (v) => ({ title: "Prepare for your visit", body: `Your appointment with ${v.provider} on ${v.when}.` }),
    hi: (v) => ({ title: "अपनी मुलाक़ात की तैयारी करें", body: `${v.provider} के साथ ${v.when} का आपका अपॉइंटमेंट।` }),
    te: (v) => ({ title: "మీ సందర్శనకు సిద్ధం అవ్వండి", body: `${v.provider} తో ${v.when} మీ అపాయింట్‌మెంట్.` }),
  },
  undefined,
  { intake: true },
);
