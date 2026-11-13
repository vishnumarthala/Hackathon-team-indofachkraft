import { appointmentTemplate } from "./appointment";

// 037 FR-4: provider only (in-app + email). The appointment page has `Add a video link`.
export default appointmentTemplate("appointment_meet_failed", {
  en: (v) => ({
    title: "Add a video link",
    body: `We could not create a Google Meet link for the video appointment on ${v.when}. Add a video link in your schedule.`,
  }),
  hi: (v) => ({
    title: "वीडियो लिंक जोड़ें",
    body: `${v.when} के वीडियो अपॉइंटमेंट के लिए हम Google Meet लिंक नहीं बना सके। अपने शेड्यूल में वीडियो लिंक जोड़ें।`,
  }),
  te: (v) => ({
    title: "వీడియో లింక్ జోడించండి",
    body: `${v.when} వీడియో అపాయింట్‌మెంట్ కోసం Google Meet లింక్ సృష్టించలేకపోయాము. మీ షెడ్యూల్‌లో వీడియో లింక్ జోడించండి.`,
  }),
});
