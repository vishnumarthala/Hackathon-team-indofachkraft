import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "provider_suspended",
  whatsapp: false,
  strings: {
    en: {
      title: "Profile suspended",
      body: "Your public profile is suspended and hidden from search. See your profile for details.",
    },
    hi: {
      title: "प्रोफ़ाइल निलंबित",
      body: "आपकी सार्वजनिक प्रोफ़ाइल निलंबित है और खोज में नहीं दिखती। विवरण अपनी प्रोफ़ाइल में देखें।",
    },
    te: {
      title: "ప్రొఫైల్ నిలిపివేయబడింది",
      body: "మీ పబ్లిక్ ప్రొఫైల్ నిలిపివేయబడింది, శోధనలో కనిపించదు. వివరాలు మీ ప్రొఫైల్‌లో చూడండి.",
    },
  },
  link: () => "/dashboard/profile",
});
