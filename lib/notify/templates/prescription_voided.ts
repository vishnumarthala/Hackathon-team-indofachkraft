import { defineTemplate, idOf } from "./shared";

// 039 FR-5: a signed prescription was cancelled by the prescriber. No clinical content outside the app.
export default defineTemplate({
  name: "prescription_voided",
  strings: {
    en: { title: "Prescription cancelled", body: "Your child's doctor cancelled a prescription. Open the app to see which one." },
    hi: {
      title: "पर्चा रद्द किया गया",
      body: "आपके बच्चे के डॉक्टर ने एक पर्चा रद्द कर दिया है। कौन-सा, यह देखने के लिए ऐप खोलें।",
    },
    te: {
      title: "ప్రిస్క్రిప్షన్ రద్దు చేయబడింది",
      body: "మీ పిల్లల డాక్టర్ ఒక ప్రిస్క్రిప్షన్‌ను రద్దు చేశారు. ఏది అని చూడటానికి యాప్‌ను తెరవండి.",
    },
  },
  whatsapp: false,
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/prescriptions` : "/family/children";
  },
});
