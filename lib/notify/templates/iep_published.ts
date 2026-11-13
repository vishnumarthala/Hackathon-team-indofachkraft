import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "iep_published",
  strings: {
    en: { title: "New plan", body: "Your child's therapist shared a new plan." },
    hi: { title: "नई योजना", body: "आपके बच्चे के थेरेपिस्ट ने एक नई योजना साझा की है।" },
    te: { title: "కొత్త ప్రణాళిక", body: "మీ పిల్లల థెరపిస్ట్ కొత్త ప్రణాళికను పంచుకున్నారు." },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}` : "/family/children";
  },
});
