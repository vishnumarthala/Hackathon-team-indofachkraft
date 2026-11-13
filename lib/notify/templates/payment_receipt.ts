// 045 FR-6: every captured payment has a DoctorNearMe receipt; the guardian opens it in the app.
import { defineTemplate, idOf } from "./shared";

export default defineTemplate({
  name: "payment_receipt",
  strings: {
    en: { title: "Payment received", body: "Thank you. Your payment on DoctorNearMe was received. Your receipt is in the app." },
    hi: {
      title: "भुगतान मिल गया",
      body: "धन्यवाद। DoctorNearMe पर आपका भुगतान मिल गया। आपकी रसीद ऐप में है।",
    },
    te: {
      title: "చెల్లింపు అందింది",
      body: "ధన్యవాదాలు. DoctorNearMe లో మీ చెల్లింపు అందింది. మీ రసీదు యాప్‌లో ఉంది.",
    },
  },
  link: ({ payload }) => {
    const childId = idOf(payload, "child_id");
    return childId ? `/family/children/${childId}/payments` : "/family/appointments";
  },
});
