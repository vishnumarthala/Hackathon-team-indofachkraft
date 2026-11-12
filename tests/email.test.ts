import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
vi.mock("@/lib/db", () => ({ supabaseAdmin: () => ({ from: () => ({ insert }) }) }));

const { audit } = await import("@/lib/audit");
const { EmailError, sendEmail } = await import("@/lib/email");

function fakeResend(result: { data: { id: string } | null; error: { message: string } | null }) {
  const send = vi.fn().mockResolvedValue(result);
  return { client: { emails: { send } }, send };
}

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("sendEmail", () => {
  it("skips sending in DEMO_MODE and audits it", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const { client, send } = fakeResend({ data: { id: "x" }, error: null });
    const result = await sendEmail({ to: "p@example.com", subject: "Hi", text: "Body", caseId: "c1" }, client);
    expect(result).toEqual({ id: "demo", delivered: false });
    expect(send).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        case_id: "c1",
        actor: "system",
        action: "email.demo_skipped",
        details: { to: "p@example.com", subject: "Hi" },
      }),
    );
  });

  it("sends from EMAIL_FROM to the recipient", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("DEMO_EMAIL_TO", "");
    vi.stubEnv("EMAIL_FROM", "");
    const { client, send } = fakeResend({ data: { id: "em_1" }, error: null });
    await expect(sendEmail({ to: "p@example.com", subject: "Hi", text: "Body" }, client)).resolves.toEqual({
      id: "em_1",
      delivered: true,
    });
    expect(send).toHaveBeenCalledWith({ from: "DoctorNearMe <onboarding@resend.dev>", to: "p@example.com", subject: "Hi", text: "Body" });
  });

  it("redirects every email to DEMO_EMAIL_TO with an Originally to line", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("DEMO_EMAIL_TO", "owner@example.com");
    const { client, send } = fakeResend({ data: { id: "em_2" }, error: null });
    await sendEmail({ to: "specialist@example.com", subject: "Referral", text: "Hello" }, client);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "owner@example.com",
      text: "Originally to: specialist@example.com\n\nHello",
    });
  });

  it("throws EmailError when Resend fails", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const { client } = fakeResend({ data: null, error: { message: "domain not verified" } });
    await expect(sendEmail({ to: "p@example.com", subject: "s", text: "t" }, client)).rejects.toThrow(EmailError);
    const throwing = { emails: { send: vi.fn().mockRejectedValue(new Error("network")) } };
    await expect(sendEmail({ to: "p@example.com", subject: "s", text: "t" }, throwing)).rejects.toThrow(
      "Email could not be sent: network",
    );
  });
});

describe("audit", () => {
  it("stores a missing caseId as null", async () => {
    await audit({ actor: "system", action: "test.event" });
    expect(insert).toHaveBeenCalledWith({
      case_id: null,
      actor: "system",
      action: "test.event",
      entity: null,
      entity_id: null,
      details: {},
    });
  });

  it("never throws and logs the failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { message: "db down" } });
    await expect(audit({ caseId: "c1", actor: "therapist", action: "x" })).resolves.toBeUndefined();
    insert.mockRejectedValue(new Error("network"));
    await expect(audit({ actor: "ai", action: "y" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("audit failed: db down");
    expect(log).toHaveBeenCalledWith("audit failed: network");
    log.mockRestore();
  });
});
