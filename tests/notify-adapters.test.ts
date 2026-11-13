// Ticket 032 FR-5 / FR-6: channel adapters with mocked providers (no real email or WhatsApp is ever sent),
// the retry schedule and error hygiene.
import { Resend } from "resend";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ supabaseAdmin: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }));

const { EmailError, sendEmail } = await import("@/lib/email");
type SendEmailInput = import("@/lib/email").SendEmailInput;
const { deliverEmail, isDeliverableAddress } = await import("@/lib/notify/email");
const { buildIcs, icsUid } = await import("@/lib/notify/ics");
const { failureDecision, MAX_ATTEMPTS, sanitizeError } = await import("@/lib/notify/retry");
const { NotifyError } = await import("@/lib/notify/types");
const { deliverWhatsApp } = await import("@/lib/notify/whatsapp");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const NID = "0f6c3c9e-8f0f-4f55-9b43-1b2a3c4d5e6f";
const CONFIG = { token: "test-token", phoneNumberId: "123456789", apiVersion: "v21.0", demoMode: false };
const WA = { name: "test_ping", language: "en", params: ["https://app.test/notifications"] };
const EMAIL = { subject: "Test notification", text: "Body", html: "<p>Body</p>" };

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe("WhatsApp adapter", () => {
  it("POSTs the approved template to the Cloud API messages endpoint", async () => {
    const fetchMock = fakeFetch(200, { messages: [{ id: "wamid.TEST" }] });
    const outcome = await deliverWhatsApp(
      { notificationId: NID, phone: "919000000001", enabled: true, content: WA },
      { fetch: fetchMock, config: CONFIG },
    );
    expect(outcome).toEqual({ status: "sent", providerMessageId: "wamid.TEST" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/123456789/messages");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919000000001",
      type: "template",
      biz_opaque_callback_data: `notification:${NID}`,
      template: {
        name: "test_ping",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "https://app.test/notifications" }] }],
      },
    });
  });

  it("is skipped (whatsapp_not_configured) without env or in DEMO_MODE, before anything else", async () => {
    const fetchMock = fakeFetch(200, {});
    const job = { notificationId: NID, phone: "919000000001", enabled: true, content: WA };
    for (const config of [
      { ...CONFIG, token: undefined },
      { ...CONFIG, phoneNumberId: undefined },
      { ...CONFIG, demoMode: true },
    ]) {
      expect(await deliverWhatsApp(job, { fetch: fetchMock, config })).toEqual({ status: "skipped", reason: "whatsapp_not_configured" });
    }
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("WHATSAPP_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    expect(await deliverWhatsApp(job)).toEqual({ status: "skipped", reason: "whatsapp_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects the preference (opted_out) and needs a verified phone (no_phone)", async () => {
    const fetchMock = fakeFetch(200, {});
    const deps = { fetch: fetchMock, config: CONFIG };
    expect(await deliverWhatsApp({ notificationId: NID, phone: "919000000001", enabled: false, content: WA }, deps)).toEqual({
      status: "skipped",
      reason: "opted_out",
    });
    expect(await deliverWhatsApp({ notificationId: NID, phone: null, enabled: true, content: WA }, deps)).toEqual({
      status: "skipped",
      reason: "no_phone",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies Meta errors: undeliverable / template missing are permanent, throttling and 5xx are not", async () => {
    const job = { notificationId: NID, phone: "919000000001", enabled: true, content: WA };
    const attempt = (status: number, body: unknown) => deliverWhatsApp(job, { fetch: fakeFetch(status, body), config: CONFIG }).catch((e) => e);
    const undeliverable = await attempt(400, { error: { code: 131026, message: "Message undeliverable" } });
    expect(undeliverable).toBeInstanceOf(NotifyError);
    expect(undeliverable).toMatchObject({ code: "whatsapp_131026", permanent: true });
    expect(await attempt(404, { error: { code: 132001, message: "Template name does not exist" } })).toMatchObject({ permanent: true });
    expect(await attempt(429, { error: { code: 130429, message: "Rate limit" } })).toMatchObject({ permanent: false });
    expect(await attempt(503, {})).toMatchObject({ code: "whatsapp_503", permanent: false });
  });
});

describe("email adapter", () => {
  const ics = { method: "REQUEST" as const, start: "2026-11-20T04:30:00.000Z", end: "2026-11-20T05:00:00.000Z", summary: "Visit" };

  function decodeIcs(send: { mock: { calls: [SendEmailInput][] } }, call: number): string {
    const input = send.mock.calls[call][0];
    return Buffer.from(input.attachments?.[0].content ?? "", "base64").toString("utf8");
  }

  it("attaches a text/calendar invite with a UID stable per aggregate and an increasing SEQUENCE", async () => {
    const send = vi.fn<(input: SendEmailInput) => Promise<{ id: string; delivered: boolean }>>(async () => ({ id: "em_1", delivered: true }));
    const uid = icsUid("appointment", "5b0c9a43-6f1e-4b8e-9d0c-111111111111");
    for (const sequence of [0, 1]) {
      await deliverEmail(
        { notificationId: NID, to: "parent@example.test", enabled: true, content: { ...EMAIL, ics }, ics: { uid, sequence } },
        { send },
      );
    }
    const [first, second] = [decodeIcs(send, 0), decodeIcs(send, 1)];
    for (const body of [first, second]) {
      expect(body).toContain(`UID:${uid}\r\n`);
      expect(body).toContain("METHOD:REQUEST\r\n");
      expect(body).toContain("DTSTART:20261120T043000Z\r\n");
      expect(body).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:parent@example.test");
    }
    expect(first).toContain("SEQUENCE:0\r\n");
    expect(second).toContain("SEQUENCE:1\r\n");
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "parent@example.test",
      subject: "Test notification",
      idempotencyKey: `notification:${NID}`,
      attachments: [{ filename: "invite.ics", contentType: "text/calendar; method=REQUEST; charset=UTF-8" }],
    });
  });

  it("sends the Resend Idempotency-Key header and the attachment through the real SDK (fetch mocked)", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("DEMO_EMAIL_TO", "");
    const fetchMock = fakeFetch(200, { id: "em_resend_1" });
    vi.stubGlobal("fetch", fetchMock);
    const resend = new Resend("re_test_key");
    const outcome = await deliverEmail(
      { notificationId: NID, to: "parent@example.test", enabled: true, content: { ...EMAIL, ics }, ics: { uid: "u@x", sequence: 2 } },
      { send: (input) => sendEmail(input, resend as never) },
    );
    expect(outcome).toEqual({ status: "sent", providerMessageId: "em_resend_1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/emails$/);
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(`notification:${NID}`);
    const body = JSON.parse(String(init?.body));
    expect(body.attachments[0]).toMatchObject({ filename: "invite.ics", content_type: "text/calendar; method=REQUEST; charset=UTF-8" });
    expect(Buffer.from(body.attachments[0].content, "base64").toString()).toContain("SEQUENCE:2");
  });

  it("keeps DEMO_MODE: nothing is sent and the row is `sent` with provider id `demo`", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const fetchMock = fakeFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    expect(await deliverEmail({ notificationId: NID, to: "parent@example.test", enabled: true, content: EMAIL })).toEqual({
      status: "sent",
      providerMessageId: "demo",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips opted-out users and accounts without a real address", async () => {
    const send = vi.fn();
    expect(await deliverEmail({ notificationId: NID, to: "p@example.test", enabled: false, content: EMAIL }, { send })).toEqual({
      status: "skipped",
      reason: "opted_out",
    });
    for (const to of [null, "", "guardian-1@phone.demo.doctornearme.invalid"]) {
      expect(await deliverEmail({ notificationId: NID, to, enabled: true, content: EMAIL }, { send })).toEqual({
        status: "skipped",
        reason: "no_email",
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(isDeliverableAddress("parent@example.test")).toBe(true);
  });

  it("invalid address (422) is permanent; provider outages are retried", async () => {
    const fail = (err: Error) => deliverEmail({ notificationId: NID, to: "p@example.test", enabled: true, content: EMAIL }, { send: async () => { throw err; } }).catch((e) => e);
    expect(await fail(new EmailError("Invalid `to` field", 422, "validation_error"))).toMatchObject({ code: "email_validation_error", permanent: true });
    expect(await fail(new EmailError("Internal error", 500, "internal_server_error"))).toMatchObject({ permanent: false });
    expect(await fail(new Error("socket hang up"))).toMatchObject({ code: "email_error", permanent: false });
  });
});

describe("retry policy and error hygiene", () => {
  it("retries after 1 min, 5 min, 30 min, 2 h, 12 h, then dead; permanent errors are dead at once", () => {
    const now = new Date("2026-11-13T00:00:00Z");
    const delays = [1, 2, 3, 4, 5].map((attempt) => {
      const d = failureDecision(attempt, false, now);
      expect(d.status).toBe("failed");
      return d.status === "failed" ? (d.nextAttemptAt.getTime() - now.getTime()) / 60_000 : -1;
    });
    expect(delays).toEqual([1, 5, 30, 120, 720]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(failureDecision(6, false, now)).toEqual({ status: "dead" });
    expect(failureDecision(1, true, now)).toEqual({ status: "dead" });
  });

  it("last_error: one line, max 500 chars, no email addresses or phone numbers", () => {
    const text = sanitizeError(new Error(`to parent@example.test (+91 90000 00001)\nfailed ${"x".repeat(900)}`));
    expect(text).not.toMatch(/example\.test|90000/);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("calendar lines are CRLF-terminated and folded at 75 octets", () => {
    const body = buildIcs({ method: "CANCEL", start: "2026-11-20T04:30:00Z", end: "2026-11-20T05:00:00Z", summary: "తెలుగు ".repeat(20) }, { uid: "u@x", sequence: 3 });
    for (const line of body.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(body).toContain("STATUS:CANCELLED");
  });
});
