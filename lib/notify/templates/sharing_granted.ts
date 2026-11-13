import { defineTemplate, idOf, roleLink } from "./shared";

// 022 FR-5: grantee organisation owners/admins. No child name, no scopes, no records.
export default defineTemplate({
  name: "sharing_granted",
  whatsapp: false,
  strings: {
    en: { title: "A family shared records", body: "A family shared their child's records with your organisation." },
    hi: { title: "एक परिवार ने रिकॉर्ड साझा किए", body: "एक परिवार ने अपने बच्चे के रिकॉर्ड आपके संगठन के साथ साझा किए हैं।" },
    te: { title: "ఒక కుటుంబం రికార్డులను పంచుకుంది", body: "ఒక కుటుంబం తమ పిల్లల రికార్డులను మీ సంస్థతో పంచుకుంది." },
  },
  link: (ctx) => {
    const caseId = idOf(ctx.payload, "grantee_case_id");
    return roleLink(ctx, "/family", caseId ? `/cases/${caseId}/shared` : "/dashboard");
  },
});
