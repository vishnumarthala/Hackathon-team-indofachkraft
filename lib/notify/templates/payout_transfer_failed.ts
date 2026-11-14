// 046 FR-3 / FR-9: platform admins learn that a payout transfer to a centre still fails after its retries (in-app +
// email; ids only, no amounts or child data).
import { defineTemplate } from "./shared";

export default defineTemplate({
  name: "payout_transfer_failed",
  whatsapp: false,
  strings: {
    en: {
      title: "Payout transfer failed",
      body: "A payout to a centre failed after its automatic retries. Check the centre's payout account and retry it in Payouts.",
    },
    hi: {
      title: "पेआउट ट्रांसफ़र विफल",
      body: "किसी सेंटर को पेआउट अपने-आप दोबारा कोशिशों के बाद भी विफल रहा। सेंटर का पेआउट खाता जाँचें और पेआउट्स में फिर से कोशिश करें।",
    },
    te: {
      title: "పేఅవుట్ ట్రాన్స్‌ఫర్ విఫలమైంది",
      body: "ఒక సెంటర్‌కు పేఅవుట్ ఆటోమేటిక్ మళ్ళీ ప్రయత్నాల తర్వాత కూడా విఫలమైంది. సెంటర్ పేఅవుట్ ఖాతాను తనిఖీ చేసి, పేఅవుట్స్‌లో మళ్ళీ ప్రయత్నించండి.",
    },
  },
  link: () => "/admin/payouts",
});
