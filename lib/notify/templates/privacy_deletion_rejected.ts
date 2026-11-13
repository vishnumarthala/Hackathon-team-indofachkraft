import { defineTemplate, idOf } from "./shared";

// 041 FR-8 / D-5: the request was refused (e.g. a clinical record-keeping duty). The reason is shown in the app only.
export default defineTemplate({
  name: "privacy_deletion_rejected",
  whatsapp: false,
  strings: {
    en: { title: "Update on your deletion request", body: "We could not carry out your deletion request. Open the app to see the reason and your options." },
    hi: { title: "आपके हटाने के अनुरोध पर अपडेट", body: "हम आपका हटाने का अनुरोध पूरा नहीं कर सके। कारण और आपके विकल्प देखने के लिए ऐप खोलें।" },
    te: { title: "మీ తొలగింపు అభ్యర్థనపై అప్‌డేట్", body: "మీ తొలగింపు అభ్యర్థనను మేము పూర్తి చేయలేకపోయాము. కారణం మరియు మీ ఎంపికలను చూడటానికి యాప్‌ను తెరవండి." },
  },
  link: (ctx) => {
    const childId = idOf(ctx.payload, "child_id");
    return childId ? `/family/children/${childId}/privacy` : "/family";
  },
});
