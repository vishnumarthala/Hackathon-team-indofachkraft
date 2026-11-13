import { defineTemplate } from "./shared";

// 027 FR-3 wording: no sender name, no child name, no message body. The event's aggregate is the thread.
export default defineTemplate({
  name: "message_created",
  strings: {
    en: { title: "New message", body: "You have a new message on DoctorNearMe." },
    hi: { title: "नया संदेश", body: "DoctorNearMe पर आपके लिए एक नया संदेश है।" },
    te: { title: "కొత్త సందేశం", body: "DoctorNearMe లో మీకు కొత్త సందేశం వచ్చింది." },
  },
  link: (ctx) => {
    const thread = ctx.event.aggregate_type === "thread" && /^[0-9a-f-]{36}$/i.test(ctx.event.aggregate_id) ? ctx.event.aggregate_id : null;
    const suffix = thread ? `/${thread}` : "";
    return ctx.role === "guardian" ? `/family/messages${suffix}` : `/dashboard/messages${suffix}`;
  },
});
