// Ticket 032 FR-3 / D-5: every template renders in en/hi/te; email and WhatsApp never carry a child's name or
// clinical terms; payloads are strict (ids only), links are app pages.
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n/config";
import { TEMPLATES } from "@/lib/notify/templates";
import { TOPICS } from "@/lib/notify/topics";

const CHILD = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const CHILD_NAME = "Asha Ramaswamy";
const DENY = /autism|ISAA|diagnos|score/i;
const APP = "https://app.doctornearme.test";
// 035: appointment intake links are an HMAC of the attempt id.
process.env.INTAKE_LINK_SECRET ??= "test-intake-link-secret";

// 030: display values only (provider, time, mode, place) - never the child.
const APPOINTMENT = {
  appointment_id: ID,
  starts_at: "2026-11-20T05:00:00Z",
  ends_at: "2026-11-20T05:30:00Z",
  provider_name: "Dr Synthetic Rao",
  mode: "in_clinic",
  time_zone: "Asia/Kolkata",
  location: "Synthetic Clinic, Road 1, Banjara Hills, Hyderabad 500034",
};

// A valid sample payload per topic.
const SAMPLES: Record<keyof typeof TOPICS, Record<string, unknown>> = {
  "test.ping": { ics_start: "2026-11-20T10:00:00+05:30" },
  "message.created": { message_id: ID },
  "document.shared_with_guardian": { document_id: ID, child_id: CHILD },
  "iep.published": { plan_id: ID, child_id: CHILD, case_id: CASE },
  "home_program.published": { program_id: ID, child_id: CHILD },
  "assessment.assigned": { assessment_id: ID, child_id: CHILD },
  "assessment.red_flag": { assessment_id: ID, child_id: CHILD, case_id: CASE },
  "assessment.submitted": { assessment_id: ID, child_id: CHILD, case_id: CASE },
  "sharing.granted": { grant_id: ID, child_id: CHILD, source_org_id: ID, grantee_org_id: USER, grantee_case_id: CASE },
  "provider.verified": { provider_profile_id: ID, submission_id: ID },
  "provider.rejected": { provider_profile_id: ID, submission_id: ID },
  "provider.suspended": { provider_profile_id: ID },
  "provider.claimed": { provider_profile_id: ID },
  "privacy.export_ready": { export_id: ID, child_id: CHILD },
  "privacy.deletion_requested": { request_id: ID, child_id: CHILD },
  "privacy.deletion_completed": { request_id: ID },
  "privacy.deletion_rejected": { request_id: ID, child_id: CHILD },
  "appointment.confirmed": APPOINTMENT,
  "appointment.reminder_day_before": APPOINTMENT,
  "appointment.reminder_two_hours": APPOINTMENT,
  "appointment.cancelled": { ...APPOINTMENT, cancelled_by: "provider" },
  "appointment.rescheduled": APPOINTMENT,
  "appointment.intake_link": { ...APPOINTMENT, intake_attempt_id: ID },
  "appointment.meet_ready": { ...APPOINTMENT, mode: "video", location: null },
  "appointment.meet_failed": { ...APPOINTMENT, mode: "video", location: null },
  "google_calendar.reconnect_required": { provider_profile_id: ID },
  "payment.refunded": { payment_id: ID, appointment_id: ID, reason: "slot_unavailable" },
};

const topics = Object.entries(TOPICS) as [keyof typeof TOPICS, (typeof TOPICS)[keyof typeof TOPICS]][];

function renderAll(topic: keyof typeof TOPICS) {
  const def = TOPICS[topic];
  const template = TEMPLATES[def.template];
  return LOCALES.flatMap((locale) =>
    (["guardian", "provider"] as const).map((role) => ({
      locale,
      role,
      out: template.render({
        payload: SAMPLES[topic] as never,
        locale,
        role,
        appUrl: APP,
        event: { id: "1", aggregate_type: "test", aggregate_id: ID },
      }),
    })),
  );
}

describe("topic registry", () => {
  it("covers the FR-2 topics and 028's provider topics, each with an existing template", () => {
    expect(Object.keys(TOPICS).sort()).toEqual(
      [
        "assessment.assigned",
        "assessment.red_flag",
        "assessment.submitted",
        "document.shared_with_guardian",
        "home_program.published",
        "iep.published",
        "message.created",
        "provider.claimed",
        "provider.rejected",
        "provider.suspended",
        "provider.verified",
        "sharing.granted",
        "test.ping",
        "privacy.export_ready",
        "privacy.deletion_requested",
        "privacy.deletion_completed",
        "privacy.deletion_rejected",
        "appointment.confirmed",
        "appointment.reminder_day_before",
        "appointment.reminder_two_hours",
        "appointment.cancelled",
        "appointment.rescheduled",
        "appointment.intake_link",
        "appointment.meet_ready",
        "appointment.meet_failed",
        "google_calendar.reconnect_required",
        "payment.refunded",
      ].sort(),
    );
    for (const [, def] of topics) expect(TEMPLATES[def.template]).toBeDefined();
  });

  it.each(topics)("%s: payload is strict (no names, no free text)", (topic, def) => {
    expect(def.payload.safeParse(SAMPLES[topic]).success).toBe(true);
    expect(def.payload.safeParse({ ...SAMPLES[topic], display_name: CHILD_NAME }).success).toBe(false);
    expect(def.payload.safeParse({ ...SAMPLES[topic], note: "score 42" }).success).toBe(false);
  });
});

describe("templates", () => {
  it.each(topics)("%s renders in en/hi/te for guardians and providers", (topic, def) => {
    const renders = renderAll(topic);
    for (const { locale, role, out } of renders) {
      const where = `${topic} ${locale} ${role}`;
      expect(out.title.trim(), where).not.toBe("");
      expect(out.body.trim(), where).not.toBe("");
      expect(out.link, where).toMatch(/^\/[a-z]/);
      expect(out.email?.subject, where).toBeTruthy();
      expect(out.email?.text, where).toContain(`${APP}${out.link}`);
      expect(out.email?.html, where).toContain(`${APP}${out.link}`);
      if (def.channels.includes("whatsapp" as never)) {
        expect(out.whatsapp, where).toMatchObject({ name: def.template, language: locale, params: [`${APP}${out.link}`] });
      }
    }
    // hi and te are real translations, not English fallbacks.
    const en = renders.find((r) => r.locale === "en")!.out;
    for (const locale of ["hi", "te"] as const) expect(renders.find((r) => r.locale === locale)!.out.body).not.toBe(en.body);
  });

  it.each(topics)("%s: email/WhatsApp contain no child name and no clinical terms", (topic) => {
    for (const { locale, role, out } of renderAll(topic)) {
      const outside = [out.email?.subject, out.email?.text, out.email?.html, ...(out.whatsapp?.params ?? []), out.title, out.body].join("\n");
      expect(outside, `${topic} ${locale} ${role}`).not.toContain(CHILD_NAME);
      expect(outside, `${topic} ${locale} ${role}`).not.toMatch(DENY);
    }
  });

  it("guardians and providers land on their own app pages", () => {
    const [guardian, provider] = (["guardian", "provider"] as const).map(
      (role) =>
        TEMPLATES.message_created.render({
          payload: SAMPLES["message.created"] as never,
          locale: "en",
          role,
          appUrl: APP,
          event: { id: "1", aggregate_type: "thread", aggregate_id: ID },
        }).link,
    );
    // 027: straight to the thread (the event's aggregate), never naming the child or sender.
    expect(guardian).toBe(`/family/messages/${ID}`);
    expect(provider).toBe(`/dashboard/messages/${ID}`);
  });

  it("sharing_granted links grantee admins to the case's Shared with us tab", () => {
    const out = TEMPLATES.sharing_granted.render({
      payload: SAMPLES["sharing.granted"] as never,
      locale: "en",
      role: "provider",
      appUrl: APP,
      event: { id: "1", aggregate_type: "sharing_grant", aggregate_id: ID },
    });
    expect(out.link).toBe(`/cases/${CASE}/shared`);
    expect(out.whatsapp).toBeUndefined();
  });

  it("030 appointment templates: provider, IST time, place; .ics REQUEST/CANCEL; family vs provider pages", () => {
    const base = { locale: "en" as const, appUrl: APP, event: { id: "1", aggregate_type: "appointment", aggregate_id: ID } };
    const payload = SAMPLES["appointment.confirmed"] as never;
    const confirmed = TEMPLATES.appointment_confirmed.render({ ...base, role: "guardian", payload });
    expect(confirmed.body).toBe(
      "Your appointment with Dr Synthetic Rao on 20 Nov 2026, 10:30 am IST is confirmed. In clinic: Synthetic Clinic, Road 1, Banjara Hills, Hyderabad 500034.",
    );
    expect(confirmed.link).toBe("/family/appointments");
    expect(confirmed.email?.ics).toMatchObject({ method: "REQUEST", start: "2026-11-20T05:00:00Z", end: "2026-11-20T05:30:00Z" });
    expect(TEMPLATES.appointment_confirmed.render({ ...base, role: "provider", payload }).link).toBe("/dashboard/schedule");
    expect(TEMPLATES.appointment_cancelled.render({ ...base, role: "guardian", payload }).email?.ics?.method).toBe("CANCEL");
    expect(TEMPLATES.appointment_reminder_2h.render({ ...base, role: "guardian", payload }).email?.ics).toBeUndefined();
    const video = TEMPLATES.appointment_reminder_24h.render({ ...base, role: "guardian", payload: { ...(payload as object), mode: "video", location: null } as never });
    expect(video.body).toContain("Video consultation");
  });

  it("test_ping adds a 30-minute calendar invite only when asked", () => {
    const base = { locale: "en" as const, role: "guardian" as const, appUrl: APP, event: { id: "1", aggregate_type: "user", aggregate_id: USER } };
    expect(TEMPLATES.test_ping.render({ ...base, payload: {} }).email?.ics).toBeUndefined();
    expect(TEMPLATES.test_ping.render({ ...base, payload: { ics_start: "2026-11-20T10:00:00+05:30" } }).email?.ics).toEqual({
      method: "REQUEST",
      start: "2026-11-20T04:30:00.000Z",
      end: "2026-11-20T05:00:00.000Z",
      summary: "DoctorNearMe test event",
    });
  });
});
