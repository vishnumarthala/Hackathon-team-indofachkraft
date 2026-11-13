import { appointmentTemplate } from "./appointment";

export default appointmentTemplate("appointment_reminder_2h", {
  en: (v) => ({ title: "Appointment in 2 hours", body: `Your appointment with ${v.provider} starts at ${v.when}. ${v.where}.` }),
  hi: (v) => ({ title: "2 घंटे में अपॉइंटमेंट", body: `${v.provider} के साथ आपका अपॉइंटमेंट ${v.when} पर शुरू होगा। ${v.where}।` }),
  te: (v) => ({ title: "2 గంటల్లో అపాయింట్‌మెంట్", body: `${v.provider} తో మీ అపాయింట్‌మెంట్ ${v.when} కి మొదలవుతుంది. ${v.where}.` }),
});
