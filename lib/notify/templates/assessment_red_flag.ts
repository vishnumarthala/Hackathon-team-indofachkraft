import { defineTemplate, idOf, roleLink } from "./shared";

// 024 FR-9: sent to the child's providers. No answers, no child name, no clinical terms outside the app.
export default defineTemplate({
  name: "assessment_red_flag",
  whatsapp: false,
  strings: {
    en: { title: "A family needs a follow-up", body: "A family's answers need your prompt review. Open the case in DoctorNearMe." },
    hi: {
      title: "एक परिवार को फ़ॉलो-अप चाहिए",
      body: "एक परिवार के जवाबों को आपकी जल्द समीक्षा चाहिए। DoctorNearMe में केस खोलें।",
    },
    te: {
      title: "ఒక కుటుంబానికి ఫాలో-అప్ అవసరం",
      body: "ఒక కుటుంబం ఇచ్చిన సమాధానాలను మీరు త్వరగా సమీక్షించాలి. DoctorNearMe లో కేసు తెరవండి.",
    },
  },
  link: (ctx) => {
    const caseId = idOf(ctx.payload, "case_id");
    return roleLink(ctx, "/family", caseId ? `/cases/${caseId}` : "/dashboard");
  },
});
