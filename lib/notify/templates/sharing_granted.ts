import { defineTemplate } from "./shared";

// 022 FR-5: grantee organisation admins.
export default defineTemplate({
  name: "sharing_granted",
  whatsapp: false,
  strings: {
    en: { title: "A family shared records", body: "A family shared their child's records with your organisation." },
    hi: { title: "एक परिवार ने रिकॉर्ड साझा किए", body: "एक परिवार ने अपने बच्चे के रिकॉर्ड आपके संगठन के साथ साझा किए हैं।" },
    te: { title: "ఒక కుటుంబం రికార్డులను పంచుకుంది", body: "ఒక కుటుంబం తమ పిల్లల రికార్డులను మీ సంస్థతో పంచుకుంది." },
  },
  link: () => "/dashboard",
});
