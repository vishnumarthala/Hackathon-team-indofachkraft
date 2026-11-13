// 045 FR-8: one reminder when a session charge is still unpaid 3 days after the session.
import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "balance_reminder",
  strings: {
    en: { title: "Payment due", body: "A payment for your child's sessions is due on DoctorNearMe. Open Payments to pay with UPI or card." },
    hi: {
      title: "भुगतान बाकी है",
      body: "DoctorNearMe पर आपके बच्चे के सेशन का भुगतान बाकी है। UPI या कार्ड से भुगतान करने के लिए भुगतान खोलें।",
    },
    te: {
      title: "చెల్లింపు బాకీ ఉంది",
      body: "DoctorNearMe లో మీ పిల్లల సెషన్ల చెల్లింపు బాకీ ఉంది. UPI లేదా కార్డుతో చెల్లించడానికి చెల్లింపులు తెరవండి.",
    },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/payments` : "/family/children";
  },
});
