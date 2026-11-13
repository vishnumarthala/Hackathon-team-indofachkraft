import { defineTemplate } from "./shared";

// 023 FR-9: no document title in email/WhatsApp.
export default defineTemplate({
  name: "document_shared",
  strings: {
    en: { title: "New document", body: "Your child's care team shared a document with you." },
    hi: { title: "नया दस्तावेज़", body: "आपके बच्चे की देखभाल टीम ने आपके साथ एक दस्तावेज़ साझा किया है।" },
    te: { title: "కొత్త పత్రం", body: "మీ పిల్లల సంరక్షణ బృందం మీతో ఒక పత్రాన్ని పంచుకుంది." },
  },
  link: () => "/family/documents",
});
