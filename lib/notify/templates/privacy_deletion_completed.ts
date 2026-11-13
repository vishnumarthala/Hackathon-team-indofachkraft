import { defineTemplate } from "./shared";

// 041 FR-8: the guardian's deletion request was carried out (in-app + email; the child's page may no longer exist).
export default defineTemplate({
  name: "privacy_deletion_completed",
  whatsapp: false,
  strings: {
    en: { title: "Your deletion request is complete", body: "We have deleted the data you asked us to delete, including copies held by our processors." },
    hi: { title: "आपका हटाने का अनुरोध पूरा हुआ", body: "आपने जो डेटा हटाने को कहा था, उसे हमने हटा दिया है, हमारे प्रोसेसरों के पास रखी कॉपी सहित।" },
    te: { title: "మీ తొలగింపు అభ్యర్థన పూర్తయింది", body: "మీరు తొలగించమని అడిగిన డేటాను, మా ప్రాసెసర్ల వద్ద ఉన్న కాపీలతో సహా, మేము తొలగించాము." },
  },
  link: () => "/family",
});
