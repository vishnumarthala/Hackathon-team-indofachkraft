import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseRow } from "@/lib/types";

const m = vi.hoisted(() => ({
  getCase: vi.fn(),
  getCaseByToken: vi.fn(),
  hasIntakeRecording: vi.fn(),
  ensureIntakeToken: vi.fn(),
  audit: vi.fn(),
  sendEmail: vi.fn(),
  startAgentSession: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireApiUser: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/authz", () => ({
  requireCaseAccess: vi.fn().mockResolvedValue(null),
  requireRecordingAccess: vi.fn().mockResolvedValue(null),
  requireReportAccess: vi.fn().mockResolvedValue(null),
  requireFactAccess: vi.fn().mockResolvedValue(null),
  requireProviderApi: vi.fn().mockResolvedValue({ actor: { user: { id: "user-1" }, role: "provider" } }),
}));
vi.mock("@/lib/consent", async () => (await import("./helpers/consent")).consentAllowedModule());
vi.mock("@/lib/queries/cases", () => ({ getCase: m.getCase }));
vi.mock("@/lib/queries/intake", () => ({
  getCaseByToken: m.getCaseByToken,
  hasIntakeRecording: m.hasIntakeRecording,
  ensureIntakeToken: m.ensureIntakeToken,
}));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/elevenlabs/agent", () => ({ startAgentSession: m.startAgentSession, DEMO_CENTRE_NAME: "DoctorNearMe Demo Centre" }));

import { POST as linkPOST } from "@/app/api/cases/[id]/intake-link/route";
import { POST as startPOST } from "@/app/api/intake/[token]/start/route";

const SECRET = "sk_test_secret_key_value";
const TOKEN = "A".repeat(43);
const CASE: CaseRow = {
  id: "00000000-0000-4000-8000-0000000000aa",
  child_alias: "Ravi",
  child_age_months: 40,
  parent_alias: "Lakshmi",
  parent_email: null,
  parent_phone: "+91 98765 43210",
  language: "te",
  therapist_name: "Demo Therapist",
  org_id: "00000000-0000-4000-8000-00000000a001",
  created_by: null,
  facp_score: null,
  status: "booked",
  intake_token: null,
  intake_token_expires_at: "2999-01-01T00:00:00Z",
  intake_token_revoked_at: null,
  created_at: "2026-11-07T00:00:00Z",
};

const post = (url: string, body?: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const linkCall = (body?: unknown, id = CASE.id) =>
  linkPOST(post(`http://x/api/cases/${id}/intake-link`, body), { params: Promise.resolve({ id }) });
const startCall = (body: unknown, token = TOKEN) =>
  startPOST(post(`http://x/api/intake/${token}/start`, body), { params: Promise.resolve({ token }) });
const actions = () => m.audit.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("ELEVENLABS_API_KEY", SECRET);
  vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_test");
  vi.stubEnv("DEMO_MODE", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/cases/:id/intake-link", () => {
  it("404 for an unknown or malformed case", async () => {
    m.getCase.mockResolvedValue(null);
    const res = await linkCall({}, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Case not found" });
  });

  it("creates the link once, returns url and WhatsApp URL, audits link_created only when new", async () => {
    m.getCase.mockResolvedValue(CASE);
    m.ensureIntakeToken.mockResolvedValueOnce({ token: TOKEN, created: true }).mockResolvedValueOnce({ token: TOKEN, created: false });

    const first = await (await linkCall()).json();
    const second = await (await linkCall({})).json();
    const url = `http://localhost:3000/intake/${TOKEN}`;
    expect(first).toEqual({ url, whatsapp_url: expect.stringMatching(/^https:\/\/wa\.me\/919876543210\?text=Hello%20Lakshmi/), emailed: false });
    expect(second.url).toBe(url);
    expect(decodeURIComponent(first.whatsapp_url.split("?text=")[1])).toContain(`in Telugu, Hindi or English: ${url}`);
    expect(actions()).toEqual(["intake.link_created"]);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("422 when asked to email without a parent email (no token created)", async () => {
    m.getCase.mockResolvedValue(CASE);
    const res = await linkCall({ send_email: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Add a parent email first" });
    expect(m.ensureIntakeToken).not.toHaveBeenCalled();
  });

  it("emails the message: delivered -> emailed true, audit link_emailed", async () => {
    m.getCase.mockResolvedValue({ ...CASE, parent_email: "parent@example.com", intake_token: TOKEN });
    m.ensureIntakeToken.mockResolvedValue({ token: TOKEN, created: false });
    m.sendEmail.mockResolvedValue({ id: "e1", delivered: true });
    const res = await linkCall({ send_email: true });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(true);
    expect(m.sendEmail).toHaveBeenCalledWith({
      to: "parent@example.com",
      subject: "Your DoctorNearMe intake call for Ravi",
      text: expect.stringMatching(/^Hello Lakshmi, this is Demo Therapist's team at DoctorNearMe\./),
      caseId: CASE.id,
    });
    expect(actions()).toEqual(["intake.link_emailed"]);
  });

  it("demo mode sender -> emailed false without email_error", async () => {
    m.getCase.mockResolvedValue({ ...CASE, parent_email: "parent@example.com" });
    m.ensureIntakeToken.mockResolvedValue({ token: TOKEN, created: false });
    m.sendEmail.mockResolvedValue({ id: "demo", delivered: false });
    const body = await (await linkCall({ send_email: true })).json();
    expect(body.emailed).toBe(false);
    expect(body.email_error).toBeUndefined();
  });

  it("Resend error -> 200 with emailed false and email_error", async () => {
    m.getCase.mockResolvedValue({ ...CASE, parent_email: "parent@example.com" });
    m.ensureIntakeToken.mockResolvedValue({ token: TOKEN, created: false });
    m.sendEmail.mockRejectedValue(new Error("Email could not be sent: boom"));
    const res = await linkCall({ send_email: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ emailed: false, email_error: "Email could not be sent" });
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});

describe("POST /api/intake/:token/start", () => {
  beforeEach(() => {
    m.getCaseByToken.mockResolvedValue({ ...CASE, intake_token: TOKEN });
    m.hasIntakeRecording.mockResolvedValue(false);
  });

  it("404 for an unknown token", async () => {
    m.getCaseByToken.mockResolvedValue(null);
    const res = await startCall({ language: "te" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This link is not valid." });
  });

  it("409 when the intake call is already complete", async () => {
    m.hasIntakeRecording.mockResolvedValue(true);
    const res = await startCall({ language: "te" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This intake call is already complete" });
  });

  it("400 for an unsupported language", async () => {
    const res = await startCall({ language: "fr" });
    expect(res.status).toBe(400);
  });

  it("DEMO_MODE returns { demo: true } without calling ElevenLabs", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await startCall({ language: "hi" });
    expect(await res.json()).toEqual({ demo: true });
    expect(m.startAgentSession).not.toHaveBeenCalled();
    expect(actions()).toEqual(["intake.started"]);
  });

  it("live returns the token, agent id and all dynamic variables; audits intake.started as parent", async () => {
    m.startAgentSession.mockResolvedValue({ agent_id: "agent_test", conversation_token: "conv_tok" });
    const res = await startCall({ language: "te" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      conversation_token: "conv_tok",
      agent_id: "agent_test",
      dynamic_variables: {
        parent_name: "Lakshmi",
        child_name: "Ravi",
        centre_name: "DoctorNearMe Demo Centre",
        case_id: CASE.id,
        intake_token: TOKEN,
        child_alias: "Ravi",
        parent_alias: "Lakshmi",
        therapist_name: "Demo Therapist",
        language: "te",
      },
    });
    expect(text).not.toContain(SECRET);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "intake.started", actor: "parent", caseId: CASE.id }));
  });

  it("public agent (no token for this key): returns the agent id with a null token", async () => {
    m.startAgentSession.mockResolvedValue({ agent_id: "agent_test", conversation_token: null });
    const body = await (await startCall({ language: "te" })).json();
    expect(body.conversation_token).toBeNull();
    expect(body.agent_id).toBe("agent_test");
    expect(body.dynamic_variables).toMatchObject({ parent_name: "Lakshmi", child_name: "Ravi", case_id: CASE.id });
  });

  it("502 when ElevenLabs fails, without leaking details", async () => {
    m.startAgentSession.mockRejectedValue(new Error(`HTTP 500 key ${SECRET}`));
    const res = await startCall({ language: "en" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Could not start the call" });
    expect(text).not.toContain(SECRET);
    expect(actions()).toEqual([]);
  });
});

describe("getConversationToken (FR-6)", () => {
  it("calls the token endpoint with the agent id and xi-api-key, returns the token", async () => {
    const { getConversationToken, CONVERSATION_TOKEN_URL } =
      await vi.importActual<typeof import("@/lib/elevenlabs/agent")>("@/lib/elevenlabs/agent");
    const fetchMock = vi.fn(async () => Response.json({ token: "abc" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(getConversationToken()).resolves.toBe("abc");
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${CONVERSATION_TOKEN_URL}?agent_id=agent_test`);
      expect(CONVERSATION_TOKEN_URL).toBe("https://api.elevenlabs.io/v1/convai/conversation/token");
      expect(init.headers).toEqual({ "xi-api-key": SECRET });

      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
      const err = await getConversationToken().catch((e: Error) => e);
      expect((err as Error).message).toContain("401");
      expect((err as Error).message).not.toContain(SECRET);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("startAgentSession", () => {
  const actual = () => vi.importActual<typeof import("@/lib/elevenlabs/agent")>("@/lib/elevenlabs/agent");
  afterEach(() => vi.unstubAllGlobals());

  it("returns a conversation token when the key can mint one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "tok" })));
    await expect((await actual()).startAgentSession()).resolves.toEqual({ agent_id: "agent_test", conversation_token: "tok" });
  });

  it.each([401, 403, 404])("falls back to the public agent id on HTTP %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status })));
    await expect((await actual()).startAgentSession()).resolves.toEqual({ agent_id: "agent_test", conversation_token: null });
  });

  it("falls back without calling ElevenLabs when no API key is set", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect((await actual()).startAgentSession()).resolves.toEqual({ agent_id: "agent_test", conversation_token: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on server errors and when no agent is configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect((await actual()).startAgentSession()).rejects.toThrow("503");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "");
    await expect((await actual()).startAgentSession()).rejects.toThrow("Missing env var: ELEVENLABS_AGENT_ID");
  });
});
