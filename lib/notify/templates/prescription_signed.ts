import { defineTemplate, idOf } from "./shared";

// 039 FR-4: no medicine names or other clinical content outside the app; in-app + email only.
export default defineTemplate({
  name: "prescription_signed",
  strings: {
    en: { title: "New prescription", body: "Your child's doctor shared a prescription with you. Open the app to view and download it." },
    hi: {
      title: "नया पर्चा",
      body: "आपके बच्चे के डॉक्टर ने आपके साथ एक पर्चा साझा किया है। उसे देखने और डाउनलोड करने के लिए ऐप खोलें।",
    },
    te: {
      title: "కొత్త ప్రిస్క్రిప్షన్",
      body: "మీ పిల్లల డాక్టర్ మీతో ఒక ప్రిస్క్రిప్షన్‌ను పంచుకున్నారు. చూడటానికి మరియు డౌన్‌లోడ్ చేయడానికి యాప్‌ను తెరవండి.",
    },
  },
  whatsapp: false,
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/prescriptions` : "/family/children";
  },
});
