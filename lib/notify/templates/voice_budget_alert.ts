import { defineTemplate } from "./shared";

type Payload = { level?: number; period?: string };

// 051 FR-5: platform admins learn that the voice budget is at 80% or used up (in-app + email; no user data).
export default defineTemplate<Payload>({
  name: "voice_budget_alert",
  whatsapp: false,
  strings: {
    en: {
      title: "Voice budget alert",
      body: "Voice calls have used a large part of today's or this month's budget. At 100% voice pauses and pages fall back to tapping. Check Operations.",
    },
    hi: {
      title: "वॉइस बजट चेतावनी",
      body: "वॉइस कॉल ने आज या इस महीने के बजट का बड़ा हिस्सा इस्तेमाल कर लिया है। 100% पर वॉइस रुक जाती है और पेज टैप करने पर लौट आते हैं। ऑपरेशंस देखें।",
    },
    te: {
      title: "వాయిస్ బడ్జెట్ హెచ్చరిక",
      body: "వాయిస్ కాల్స్ ఈ రోజు లేదా ఈ నెల బడ్జెట్‌లో ఎక్కువ భాగం వాడేశాయి. 100% వద్ద వాయిస్ ఆగిపోతుంది, పేజీలు ట్యాప్ చేయడానికి మారతాయి. ఆపరేషన్స్ చూడండి.",
    },
  },
  link: () => "/admin/ops",
});
