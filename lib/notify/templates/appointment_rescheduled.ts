import { appointmentTemplate } from "./appointment";

export default appointmentTemplate(
  "appointment_rescheduled",
  {
    en: (v) =>
      v.role === "guardian"
        ? { title: "Appointment moved", body: `Your appointment with ${v.provider} is now on ${v.when}. ${v.where}.` }
        : { title: "Appointment moved", body: `An appointment was moved to ${v.when}. ${v.where}.` },
    hi: (v) =>
      v.role === "guardian"
        ? { title: "अपॉइंटमेंट का समय बदला", body: `${v.provider} के साथ आपका अपॉइंटमेंट अब ${v.when} को है। ${v.where}।` }
        : { title: "अपॉइंटमेंट का समय बदला", body: `एक अपॉइंटमेंट ${v.when} पर बदला गया। ${v.where}।` },
    te: (v) =>
      v.role === "guardian"
        ? { title: "అపాయింట్‌మెంట్ సమయం మారింది", body: `${v.provider} తో మీ అపాయింట్‌మెంట్ ఇప్పుడు ${v.when} న ఉంది. ${v.where}.` }
        : { title: "అపాయింట్‌మెంట్ సమయం మారింది", body: `ఒక అపాయింట్‌మెంట్ ${v.when} కి మార్చబడింది. ${v.where}.` },
  },
  "REQUEST",
);
