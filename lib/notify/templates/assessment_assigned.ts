import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "assessment_assigned",
  strings: {
    en: { title: "A questionnaire for you", body: "Your child's care team sent you a questionnaire to fill in." },
    hi: { title: "आपके लिए एक प्रश्नावली", body: "आपके बच्चे की देखभाल टीम ने आपको भरने के लिए एक प्रश्नावली भेजी है।" },
    te: { title: "మీ కోసం ఒక ప్రశ్నావళి", body: "మీ పిల్లల సంరక్షణ బృందం మీకు నింపడానికి ఒక ప్రశ్నావళిని పంపింది." },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}` : "/family/children";
  },
});
