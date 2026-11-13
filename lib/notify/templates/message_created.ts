import { defineTemplate, idOf, roleLink } from "./shared";

// 027 FR-3 wording: no sender name, no child name, no message body.
export default defineTemplate({
  name: "message_created",
  strings: {
    en: { title: "New message", body: "You have a new message on DoctorNearMe." },
    hi: { title: "नया संदेश", body: "DoctorNearMe पर आपके लिए एक नया संदेश है।" },
    te: { title: "కొత్త సందేశం", body: "DoctorNearMe లో మీకు కొత్త సందేశం వచ్చింది." },
  },
  link: (ctx) => {
    const caseId = idOf(ctx.payload, "case_id");
    return roleLink(ctx, "/family/messages", caseId ? `/cases/${caseId}` : "/dashboard");
  },
});
