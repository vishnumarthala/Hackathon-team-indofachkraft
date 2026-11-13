import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "provider_rejected",
  whatsapp: false,
  strings: {
    en: {
      title: "Verification not approved",
      body: "Your credential submission was not approved. See your profile for the next steps.",
    },
    hi: { title: "सत्यापन स्वीकृत नहीं हुआ", body: "आपके प्रमाण-पत्र स्वीकृत नहीं हुए। अगले कदम अपनी प्रोफ़ाइल में देखें।" },
    te: {
      title: "ధృవీకరణ ఆమోదించబడలేదు",
      body: "మీరు సమర్పించిన ధృవపత్రాలు ఆమోదించబడలేదు. తదుపరి దశలను మీ ప్రొఫైల్‌లో చూడండి.",
    },
  },
  link: () => "/dashboard/profile",
});
