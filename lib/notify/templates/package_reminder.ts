// 045 FR-8: one reminder when a package has 2 or fewer sessions left or expires within 7 days.
import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "package_reminder",
  strings: {
    en: { title: "Package ending soon", body: "Your child's session package is ending soon. Talk to the centre about the next package." },
    hi: {
      title: "पैकेज जल्द खत्म होगा",
      body: "आपके बच्चे का सेशन पैकेज जल्द खत्म हो रहा है। अगले पैकेज के लिए सेंटर से बात करें।",
    },
    te: {
      title: "ప్యాకేజీ త్వరలో ముగుస్తుంది",
      body: "మీ పిల్లల సెషన్ ప్యాకేజీ త్వరలో ముగుస్తుంది. తదుపరి ప్యాకేజీ గురించి సెంటర్‌తో మాట్లాడండి.",
    },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/payments` : "/family/children";
  },
});
