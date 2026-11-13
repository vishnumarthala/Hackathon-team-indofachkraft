// 045 FR-3 / FR-7: a centre asks the family to pay (package offer or the balance) on DoctorNearMe. No amount, no centre
// or child name outside the app; the app page shows the details and the `Pay` button.
import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "payment_request",
  strings: {
    en: {
      title: "Payment request",
      body: "Your child's centre sent a payment request on DoctorNearMe. Open Payments to pay with UPI or card.",
    },
    hi: {
      title: "भुगतान का अनुरोध",
      body: "आपके बच्चे के सेंटर ने DoctorNearMe पर भुगतान का अनुरोध भेजा है। UPI या कार्ड से भुगतान करने के लिए भुगतान खोलें।",
    },
    te: {
      title: "చెల్లింపు అభ్యర్థన",
      body: "మీ పిల్లల సెంటర్ DoctorNearMe లో చెల్లింపు అభ్యర్థన పంపింది. UPI లేదా కార్డుతో చెల్లించడానికి చెల్లింపులు తెరవండి.",
    },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/payments` : "/family/children";
  },
});
