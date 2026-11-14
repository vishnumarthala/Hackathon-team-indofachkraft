// 046 FR-10: the daily reconciliation found payments where transferred + refunded + platform share differ from what was
// captured (in-app + email to platform admins; a count only).
import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "payout_reconciliation_alert",
  whatsapp: false,
  strings: {
    en: {
      title: "Payout reconciliation mismatch",
      body: "Today's reconciliation found payments whose payouts, refunds and platform fee do not add up to what the family paid. Check Payouts.",
    },
    hi: {
      title: "पेआउट मिलान में अंतर",
      body: "आज के मिलान में ऐसे भुगतान मिले जिनके पेआउट, रिफंड और प्लैटफ़ॉर्म शुल्क मिलकर परिवार के भुगतान के बराबर नहीं हैं। पेआउट्स देखें।",
    },
    te: {
      title: "పేఅవుట్ సరిపోలికలో తేడా",
      body: "ఈ రోజు సరిపోలికలో కొన్ని చెల్లింపుల పేఅవుట్లు, రీఫండ్లు, ప్లాట్‌ఫామ్ ఫీజు కలిపి కుటుంబం చెల్లించిన మొత్తానికి సరిపోలలేదు. పేఅవుట్స్ చూడండి.",
    },
  },
  link: () => "/admin/payouts",
});
