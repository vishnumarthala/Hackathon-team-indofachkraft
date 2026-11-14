// 046 FR-7: the centre's monthly platform-fee tax invoice is ready (in-app + email to owners/admins; no amounts).
import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "payout_invoice_issued",
  whatsapp: false,
  strings: {
    en: {
      title: "Platform fee invoice ready",
      body: "Last month's DoctorNearMe platform fee tax invoice is ready. The fee was already deducted from your payouts. Download it in Payouts.",
    },
    hi: {
      title: "प्लैटफ़ॉर्म शुल्क इनवॉइस तैयार",
      body: "पिछले महीने का DoctorNearMe प्लैटफ़ॉर्म शुल्क टैक्स इनवॉइस तैयार है। शुल्क आपके पेआउट से पहले ही काटा जा चुका है। इसे पेआउट्स में डाउनलोड करें।",
    },
    te: {
      title: "ప్లాట్‌ఫామ్ ఫీజు ఇన్‌వాయిస్ సిద్ధం",
      body: "గత నెల DoctorNearMe ప్లాట్‌ఫామ్ ఫీజు ట్యాక్స్ ఇన్‌వాయిస్ సిద్ధంగా ఉంది. ఫీజు ఇప్పటికే మీ పేఅవుట్ల నుండి తీసివేయబడింది. పేఅవుట్స్‌లో డౌన్‌లోడ్ చేయండి.",
    },
  },
  link: () => "/dashboard/payouts",
});
