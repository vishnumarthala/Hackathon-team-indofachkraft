import { defineTemplate } from "./shared";

// 037 FR-2: the stored Google grant stopped working (`invalid_grant`). Provider only, in-app + email.
export default defineTemplate({
  name: "google_calendar_reconnect",
  whatsapp: false,
  strings: {
    en: {
      title: "Reconnect Google Calendar",
      body: "DoctorNearMe can no longer create Google Meet links for your video appointments. Reconnect Google Calendar in Settings.",
    },
    hi: {
      title: "Google Calendar फिर से जोड़ें",
      body: "DoctorNearMe अब आपके वीडियो अपॉइंटमेंट के लिए Google Meet लिंक नहीं बना सकता। सेटिंग्स में Google Calendar फिर से जोड़ें।",
    },
    te: {
      title: "Google Calendar మళ్లీ కనెక్ట్ చేయండి",
      body: "DoctorNearMe ఇక మీ వీడియో అపాయింట్‌మెంట్‌లకు Google Meet లింక్‌లు సృష్టించలేదు. సెట్టింగ్స్‌లో Google Calendar మళ్లీ కనెక్ట్ చేయండి.",
    },
  },
  link: () => "/dashboard/settings/integrations",
});
