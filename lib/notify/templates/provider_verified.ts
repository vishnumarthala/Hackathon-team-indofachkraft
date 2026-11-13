import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "provider_verified",
  whatsapp: false,
  strings: {
    en: { title: "Your profile is verified", body: "Your DoctorNearMe profile is verified. See your profile for details." },
    hi: {
      title: "आपकी प्रोफ़ाइल सत्यापित हो गई",
      body: "आपकी DoctorNearMe प्रोफ़ाइल सत्यापित हो गई है। विवरण अपनी प्रोफ़ाइल में देखें।",
    },
    te: {
      title: "మీ ప్రొఫైల్ ధృవీకరించబడింది",
      body: "మీ DoctorNearMe ప్రొఫైల్ ధృవీకరించబడింది. వివరాలు మీ ప్రొఫైల్‌లో చూడండి.",
    },
  },
  link: () => "/dashboard/profile",
});
