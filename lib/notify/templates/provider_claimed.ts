import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "provider_claimed",
  whatsapp: false,
  strings: {
    en: { title: "Profile claimed", body: "You now manage your DoctorNearMe profile." },
    hi: { title: "प्रोफ़ाइल आपकी हुई", body: "अब आप अपनी DoctorNearMe प्रोफ़ाइल संभालते हैं।" },
    te: { title: "ప్రొఫైల్ మీదైంది", body: "ఇప్పుడు మీ DoctorNearMe ప్రొఫైల్‌ను మీరే నిర్వహిస్తారు." },
  },
  link: () => "/dashboard/profile",
});
