import { appointmentTemplate } from "./appointment";

export default appointmentTemplate(
  "appointment_cancelled",
  {
    en: (v) =>
      v.role === "guardian"
        ? { title: "Appointment cancelled", body: `Your appointment with ${v.provider} on ${v.when} was cancelled.` }
        : { title: "Appointment cancelled", body: `The appointment on ${v.when} was cancelled.` },
    hi: (v) =>
      v.role === "guardian"
        ? { title: "अपॉइंटमेंट रद्द हुआ", body: `${v.provider} के साथ ${v.when} का आपका अपॉइंटमेंट रद्द हो गया।` }
        : { title: "अपॉइंटमेंट रद्द हुआ", body: `${v.when} का अपॉइंटमेंट रद्द हो गया।` },
    te: (v) =>
      v.role === "guardian"
        ? { title: "అపాయింట్‌మెంట్ రద్దయింది", body: `${v.provider} తో ${v.when} మీ అపాయింట్‌మెంట్ రద్దయింది.` }
        : { title: "అపాయింట్‌మెంట్ రద్దయింది", body: `${v.when} అపాయింట్‌మెంట్ రద్దయింది.` },
  },
  "CANCEL",
);
