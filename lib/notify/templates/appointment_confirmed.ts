import { appointmentTemplate } from "./appointment";

export default appointmentTemplate(
  "appointment_confirmed",
  {
    en: (v) =>
      v.role === "guardian"
        ? { title: "Appointment confirmed", body: `Your appointment with ${v.provider} on ${v.when} is confirmed. ${v.where}.` }
        : { title: "New appointment", body: `New appointment on ${v.when}. ${v.where}.` },
    hi: (v) =>
      v.role === "guardian"
        ? { title: "अपॉइंटमेंट पक्की हुई", body: `${v.provider} के साथ ${v.when} का आपका अपॉइंटमेंट पक्का हो गया है। ${v.where}।` }
        : { title: "नया अपॉइंटमेंट", body: `${v.when} को नया अपॉइंटमेंट। ${v.where}।` },
    te: (v) =>
      v.role === "guardian"
        ? { title: "అపాయింట్‌మెంట్ ధృవీకరించబడింది", body: `${v.provider} తో ${v.when} మీ అపాయింట్‌మెంట్ ధృవీకరించబడింది. ${v.where}.` }
        : { title: "కొత్త అపాయింట్‌మెంట్", body: `${v.when} న కొత్త అపాయింట్‌మెంట్. ${v.where}.` },
  },
  "REQUEST",
  { intake: true, whatsappIntakeVariants: true },
);
