// 045 FR-9: a refund (unused package sessions, a session charge) reached the family's account. In-app + email.
import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "fees_refunded",
  whatsapp: false,
  strings: {
    en: { title: "Refund sent", body: "A refund was sent to the account you paid from. It can take 5-7 working days to show." },
    hi: {
      title: "रिफंड भेजा गया",
      body: "जिस खाते से आपने भुगतान किया था, उसमें रिफंड भेज दिया गया है। दिखने में 5-7 कामकाजी दिन लग सकते हैं।",
    },
    te: {
      title: "రీఫండ్ పంపబడింది",
      body: "మీరు చెల్లించిన ఖాతాకు రీఫండ్ పంపబడింది. కనిపించడానికి 5-7 పని దినాలు పట్టవచ్చు.",
    },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/payments` : "/family/children";
  },
});
