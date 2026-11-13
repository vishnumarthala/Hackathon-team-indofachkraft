import { appointmentTemplate } from "./appointment";

export default appointmentTemplate("appointment_reminder_24h", {
  en: (v) => ({ title: "Appointment tomorrow", body: `Reminder: your appointment with ${v.provider} is on ${v.when}. ${v.where}.` }),
  hi: (v) => ({ title: "कल अपॉइंटमेंट है", body: `याद दिलाना: ${v.provider} के साथ आपका अपॉइंटमेंट ${v.when} को है। ${v.where}।` }),
  te: (v) => ({ title: "రేపు అపాయింట్‌మెంట్", body: `గుర్తు: ${v.provider} తో మీ అపాయింట్‌మెంట్ ${v.when} న ఉంది. ${v.where}.` }),
});
