import { appointmentTemplate } from "./appointment";

// 037: the video link exists. The Meet link itself is never in the message: guardians and providers join from the
// appointment page (Join video call, from 10 minutes before the start).
export default appointmentTemplate("appointment_meet_ready", {
  en: (v) =>
    v.role === "guardian"
      ? {
          title: "Video call link ready",
          body: `The video call link for your appointment with ${v.provider} on ${v.when} is ready. Join from DoctorNearMe with your Google account; the provider will admit you.`,
        }
      : { title: "Google Meet link ready", body: `The Google Meet link for the video appointment on ${v.when} is ready in your schedule.` },
  hi: (v) =>
    v.role === "guardian"
      ? {
          title: "वीडियो कॉल लिंक तैयार है",
          body: `${v.provider} के साथ ${v.when} के आपके अपॉइंटमेंट का वीडियो कॉल लिंक तैयार है। अपने Google खाते से DoctorNearMe में जुड़ें; प्रदाता आपको अंदर लेंगे।`,
        }
      : { title: "Google Meet लिंक तैयार है", body: `${v.when} के वीडियो अपॉइंटमेंट का Google Meet लिंक आपके शेड्यूल में तैयार है।` },
  te: (v) =>
    v.role === "guardian"
      ? {
          title: "వీడియో కాల్ లింక్ సిద్ధంగా ఉంది",
          body: `${v.provider} తో ${v.when} మీ అపాయింట్‌మెంట్ వీడియో కాల్ లింక్ సిద్ధంగా ఉంది. మీ Google ఖాతాతో DoctorNearMe నుండి చేరండి; ప్రొవైడర్ మిమ్మల్ని లోపలికి అనుమతిస్తారు.`,
        }
      : { title: "Google Meet లింక్ సిద్ధంగా ఉంది", body: `${v.when} వీడియో అపాయింట్‌మెంట్ Google Meet లింక్ మీ షెడ్యూల్‌లో సిద్ధంగా ఉంది.` },
});
