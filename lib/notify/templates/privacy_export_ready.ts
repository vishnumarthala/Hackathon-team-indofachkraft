import { defineTemplate, idOf } from "./shared";

// 041 FR-7: the guardian's data export is ready to download (in-app + email; no child name).
export default defineTemplate({
  name: "privacy_export_ready",
  whatsapp: false,
  strings: {
    en: { title: "Your data download is ready", body: "The copy of your child's data you asked for is ready. It can be downloaded for 7 days." },
    hi: { title: "आपका डेटा डाउनलोड तैयार है", body: "आपने अपने बच्चे के डेटा की जो कॉपी माँगी थी, वह तैयार है। इसे 7 दिनों तक डाउनलोड किया जा सकता है।" },
    te: { title: "మీ డేటా డౌన్‌లోడ్ సిద్ధంగా ఉంది", body: "మీరు అడిగిన మీ పిల్లల డేటా కాపీ సిద్ధంగా ఉంది. దీన్ని 7 రోజుల పాటు డౌన్‌లోడ్ చేసుకోవచ్చు." },
  },
  link: (ctx) => {
    const childId = idOf(ctx.payload, "child_id");
    return childId ? `/family/children/${childId}/privacy` : "/family";
  },
});
