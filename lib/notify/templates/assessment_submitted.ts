import { defineTemplate, idOf, roleLink } from "./shared";

// 024 FR-9: a guardian submitted a questionnaire; sent to the case's providers. No answers, score or child name.
export default defineTemplate({
  name: "assessment_submitted",
  whatsapp: false,
  strings: {
    en: { title: "A questionnaire was returned", body: "A family returned a questionnaire. Review it in DoctorNearMe." },
    hi: { title: "एक प्रश्नावली वापस आई", body: "एक परिवार ने प्रश्नावली भरकर भेजी है। DoctorNearMe में इसकी समीक्षा करें।" },
    te: { title: "ఒక ప్రశ్నావళి తిరిగి వచ్చింది", body: "ఒక కుటుంబం ప్రశ్నావళిని నింపి పంపింది. DoctorNearMe లో సమీక్షించండి." },
  },
  link: (ctx) => {
    const caseId = idOf(ctx.payload, "case_id");
    const id = idOf(ctx.payload, "assessment_id");
    return roleLink(ctx, "/family", caseId && id ? `/cases/${caseId}/assessments/${id}` : "/dashboard");
  },
});
