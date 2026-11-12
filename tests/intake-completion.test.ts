import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type { CaseRow } from "@/lib/types";

// DB integration tests (isolated `a010` cases in the configured Supabase database) run only with
// CT_DB_TESTS=1, so `npm run verify` never writes to a shared database.
const DB_TESTS = process.env.CT_DB_TESTS === "1";
if (DB_TESTS) process.loadEnvFile(path.join(process.cwd(), ".env.local"));

// Every mock below defaults to its real implementation in the DB tests (see useRealImplementations).
const m = vi.hoisted(() => ({
  process: vi.fn(),
  getCaseByToken: vi.fn(),
  markBriefReviewed: vi.fn(),
  getConversation: vi.fn(),
  audit: vi.fn(),
  generateJson: vi.fn(),
  sdkOptions: null as null | Record<string, (arg?: unknown) => void>,
}));
vi.mock("@/lib/auth", () => ({ requireApiUser: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/authz", () => ({
  requireCaseAccess: vi.fn().mockResolvedValue(null),
  requireRecordingAccess: vi.fn().mockResolvedValue(null),
  requireReportAccess: vi.fn().mockResolvedValue(null),
  requireFactAccess: vi.fn().mockResolvedValue(null),
  requireProviderApi: vi.fn().mockResolvedValue({ actor: { user: { id: "user-1" }, role: "provider" } }),
}));
vi.mock("@/lib/intake/process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/intake/process")>()),
  processPostCall: m.process,
}));
vi.mock("@/lib/queries/intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/intake")>()),
  getCaseByToken: m.getCaseByToken,
  markBriefReviewed: m.markBriefReviewed,
}));
vi.mock("@/lib/elevenlabs/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/elevenlabs/agent")>()),
  getConversation: m.getConversation,
}));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  generateJson: m.generateJson,
}));
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: (options: Record<string, (arg?: unknown) => void>) => {
    m.sdkOptions = options;
    return { status: "disconnected", startSession: vi.fn(), endSession: vi.fn(), getId: () => "" };
  },
}));

import { POST as reviewedPOST } from "@/app/api/cases/[id]/brief/reviewed/route";
import { POST as simulatePOST } from "@/app/api/dev/simulate-intake/[token]/route";
import { POST as completePOST } from "@/app/api/intake/[token]/complete/route";
import { POST as webhookPOST } from "@/app/api/webhooks/elevenlabs/route";
import { BRIEF_FAILED, BriefSection, markBriefReviewed as reviewClient } from "@/components/intake/BriefSection";
import {
  COMPLETION_POLL_MS,
  COMPLETION_TIMEOUT_MS,
  completionText,
  createCompletionPoller,
  IntakeCall,
  MESSAGES,
  type CompletionState,
} from "@/components/intake/IntakeCall";
import { SIMULATE_DONE, SIMULATE_LABEL, SimulateCallButton, simulateIntake } from "@/components/intake/SimulateCallButton";
import { ProviderError } from "@/lib/elevenlabs/agent";
import { GeminiError } from "@/lib/gemini";
import { briefStateFrom } from "@/lib/intake/briefMarkdown";
import { InvalidPostCallError } from "@/lib/intake/process";
import { signPayload } from "@/lib/intake/signature";
import { BriefSchema } from "@/lib/types";
import { withI18n } from "./helpers/i18n";

const SECRET = "test-secret";
const API_KEY = "sk_test_never_returned_1234";
const AGENT = "agent_test";
const TOKEN = "B".repeat(43);
const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures/elevenlabs-post-call.json"), "utf8"));
const briefFixture = BriefSchema.parse(
  JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures/gemini/brief.json"), "utf8")),
);
const CASE = {
  id: "00000000-0000-4000-8000-0000000000bb",
  child_alias: "Ravi",
  therapist_name: "Demo Therapist",
  intake_token: TOKEN,
  status: "booked",
} as unknown as CaseRow;
const PROCESSED = { received: true, case_id: CASE.id, recording_id: "rec-1", brief: true };

function postCallData(token: string, conversationId: string) {
  const data = structuredClone(fixture.data);
  data.conversation_id = conversationId;
  data.agent_id = AGENT;
  data.conversation_initiation_client_data.dynamic_variables.intake_token = token;
  return data;
}

const webhookCall = (body: string, header?: string | null) =>
  webhookPOST(
    new Request("http://x/api/webhooks/elevenlabs", {
      method: "POST",
      headers: header ? { "elevenlabs-signature": header } : {},
      body,
    }),
  );
const signedWebhook = (payload: unknown, t?: number) => {
  const body = JSON.stringify(payload);
  return webhookCall(body, signPayload(body, SECRET, t));
};
const completeCall = (body: unknown, token = TOKEN) =>
  completePOST(
    new Request(`http://x/api/intake/${token}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
const simulateCall = (token = TOKEN) =>
  simulatePOST(new Request(`http://x/api/dev/simulate-intake/${token}`, { method: "POST" }), {
    params: Promise.resolve({ token }),
  });
const reviewedCall = (id: string) =>
  reviewedPOST(new Request(`http://x/api/cases/${id}/brief/reviewed`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

function stubEnv(demo: boolean) {
  vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("ELEVENLABS_API_KEY", API_KEY);
  vi.stubEnv("ELEVENLABS_AGENT_ID", AGENT);
  vi.stubEnv("DEMO_MODE", demo ? "true" : "false");
  vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// =============================================================================================
describe("mocked routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubEnv(false);
    m.getCaseByToken.mockImplementation(async (t: string) => (t === TOKEN ? CASE : null));
    m.process.mockResolvedValue(PROCESSED);
  });

  describe("E-1 webhook signature (FR-1)", () => {
    const payload = { type: "post_call_transcription", data: postCallData(TOKEN, "conv_w1") };
    const body = JSON.stringify(payload);
    const now = () => Math.floor(Date.now() / 1000);

    it("valid signature -> 200 with the processor result; processor gets payload.data", async () => {
      const res = await signedWebhook(payload);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PROCESSED);
      expect(m.process).toHaveBeenCalledWith(payload.data);
    });

    it.each([
      ["missing header", null],
      ["bad hex", `t=${Math.floor(Date.now() / 1000)},v0=${"0".repeat(64)}`],
      ["old timestamp", signPayload(body, SECRET, Math.floor(Date.now() / 1000) - 31 * 60)],
      ["future timestamp", signPayload(body, SECRET, Math.floor(Date.now() / 1000) + 10 * 60)],
      ["malformed header", "garbage"],
      ["wrong scheme", signPayload(body, SECRET).replace("v0=", "v1=")],
      ["mismatched secret", signPayload(body, "other-secret")],
    ])("%s -> 401 Invalid signature, nothing processed", async (_name, header) => {
      const res = await webhookCall(body, header);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid signature" });
      expect(m.process).not.toHaveBeenCalled();
    });

    it("signature over a different body (tampered) -> 401", async () => {
      const res = await webhookCall(body.replace("conv_w1", "conv_w2"), signPayload(body, SECRET, now()));
      expect(res.status).toBe(401);
    });

    it("webhook secret not configured -> 401", async () => {
      vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", "");
      const res = await signedWebhook(payload);
      expect(res.status).toBe(401);
    });

    it("unrelated signed event -> 200 ignored with its type", async () => {
      const res = await signedWebhook({ type: "post_call_audio", data: {} });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, ignored: "post_call_audio" });
      expect(m.process).not.toHaveBeenCalled();
    });

    it("signed but not JSON -> 400; invalid data -> 400; save failure -> 500", async () => {
      expect((await webhookCall("not json", signPayload("not json", SECRET))).status).toBe(400);
      m.process.mockRejectedValueOnce(new InvalidPostCallError("bad"));
      expect((await signedWebhook(payload)).status).toBe(400);
      m.process.mockRejectedValueOnce(new Error("db down"));
      const res = await signedWebhook(payload);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Could not save the call" });
    });

    it("unknown token and duplicate results are passed through as 200 (NFR-2)", async () => {
      m.process.mockResolvedValueOnce({ received: true, ignored: "unknown token" });
      const a = await signedWebhook(payload);
      expect([a.status, await a.json()]).toEqual([200, { received: true, ignored: "unknown token" }]);
      m.process.mockResolvedValueOnce({ received: true, duplicate: true });
      const b = await signedWebhook(payload);
      expect([b.status, await b.json()]).toEqual([200, { received: true, duplicate: true }]);
    });
  });

  describe("E-2 completion endpoint (FR-11)", () => {
    const conversation = (overrides: Record<string, unknown> = {}) => ({
      ...postCallData(TOKEN, "conv_c1"),
      ...overrides,
    });

    it.each(["initiated", "in-progress", "processing"])("status %s -> 202 processing, nothing saved", async (status) => {
      m.getConversation.mockResolvedValue(conversation({ status }));
      const res = await completeCall({ conversation_id: "conv_c1" });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "processing" });
      expect(m.getConversation).toHaveBeenCalledWith("conv_c1");
      expect(m.process).not.toHaveBeenCalled();
    });

    it("pending status without a reported token yet is still 202", async () => {
      m.getConversation.mockResolvedValue({ agent_id: AGENT, status: "in-progress", conversation_id: "conv_c1" });
      expect((await completeCall({ conversation_id: "conv_c1" })).status).toBe(202);
    });

    it("done for the expected agent and token -> 200 with the processor result", async () => {
      m.getConversation.mockResolvedValue(conversation({ status: "done" }));
      const res = await completeCall({ conversation_id: "conv_c1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PROCESSED);
      const data = m.process.mock.calls[0][0];
      expect(data.conversation_id).toBe("conv_c1");
      expect(data.conversation_initiation_client_data.dynamic_variables.intake_token).toBe(TOKEN);
      expect(data.transcript).toHaveLength(fixture.data.transcript.length);
    });

    it.each([
      ["agent mismatch", { agent_id: "agent_other" }],
      ["agent missing", { agent_id: undefined }],
      [
        "token mismatch",
        { conversation_initiation_client_data: { dynamic_variables: { intake_token: "C".repeat(43) } } },
      ],
      ["token missing", { conversation_initiation_client_data: { dynamic_variables: {} } }],
      ["conversation id mismatch", { conversation_id: "conv_other" }],
    ])("%s on a done call -> 403, nothing saved", async (_name, overrides) => {
      m.getConversation.mockResolvedValue(conversation({ status: "done", ...overrides }));
      const res = await completeCall({ conversation_id: "conv_c1" });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("This call does not belong to this intake link");
      expect(m.process).not.toHaveBeenCalled();
    });

    it("token mismatch is rejected even while pending", async () => {
      m.getConversation.mockResolvedValue(
        conversation({
          status: "processing",
          conversation_initiation_client_data: { dynamic_variables: { intake_token: "C".repeat(43) } },
        }),
      );
      expect((await completeCall({ conversation_id: "conv_c1" })).status).toBe(403);
    });

    it.each([
      ["failed status", () => m.getConversation.mockResolvedValue(conversation({ status: "failed" })), /failed/],
      ["unknown status", () => m.getConversation.mockResolvedValue(conversation({ status: "archived" })), /Unexpected call status/],
      ["no status", () => m.getConversation.mockResolvedValue(conversation({ status: undefined })), /Unexpected response/],
      [
        "done but malformed transcript",
        () => m.getConversation.mockResolvedValue(conversation({ status: "done", transcript: "x" })),
        /Unexpected response/,
      ],
      [
        "provider unavailable",
        () => m.getConversation.mockRejectedValue(new ProviderError("Conversation request failed (HTTP 503)")),
        /Could not retrieve the call/,
      ],
      [
        "provider body not JSON",
        () => m.getConversation.mockRejectedValue(new ProviderError("Conversation response was not a JSON object")),
        /Could not retrieve the call/,
      ],
    ])("%s -> explicit 502, nothing saved", async (_name, setup, pattern) => {
      setup();
      const res = await completeCall({ conversation_id: "conv_c1" });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toMatch(pattern);
      expect(JSON.stringify(body)).not.toContain(API_KEY);
      expect(m.process).not.toHaveBeenCalled();
    });

    it.each([
      ["missing conversation_id", {}],
      ["empty conversation_id", { conversation_id: "" }],
      ["non-string conversation_id", { conversation_id: 5 }],
      ["path characters", { conversation_id: "../x" }],
      ["non-JSON body", "nope"],
    ])("invalid body (%s) -> 400", async (_name, body) => {
      const res = await completeCall(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid request");
      expect(m.getConversation).not.toHaveBeenCalled();
    });

    it("unknown token -> 404, no provider request", async () => {
      const res = await completeCall({ conversation_id: "conv_c1" }, "Z".repeat(43));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This link is not valid." });
      expect(m.getConversation).not.toHaveBeenCalled();
    });

    it("processor failure -> 500 Could not save the call", async () => {
      m.getConversation.mockResolvedValue(conversation({ status: "done" }));
      m.process.mockRejectedValue(new Error("tx failed"));
      const res = await completeCall({ conversation_id: "conv_c1" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Could not save the call" });
    });

    it("demo mode: uses the fixture, never the provider", async () => {
      stubEnv(true);
      const res = await completeCall({ conversation_id: "demo-123" });
      expect(res.status).toBe(200);
      expect(m.getConversation).not.toHaveBeenCalled();
      const data = m.process.mock.calls[0][0];
      expect(data.conversation_id).toBe("demo-123");
      expect(data.conversation_initiation_client_data.dynamic_variables.intake_token).toBe(TOKEN);
    });

    it("the provider key never appears in a response", async () => {
      for (const status of ["done", "processing", "failed"]) {
        m.getConversation.mockResolvedValue(conversation({ status }));
        const res = await completeCall({ conversation_id: "conv_c1" });
        expect(await res.text()).not.toContain(API_KEY);
      }
    });
  });

  describe("E-4 simulate and review routes (FR-6, FR-9)", () => {
    it("simulate outside demo mode -> 404 Not found", async () => {
      const res = await simulateCall();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
      expect(m.process).not.toHaveBeenCalled();
    });

    it("simulate with an unknown token -> 404 This link is not valid.", async () => {
      stubEnv(true);
      const res = await simulateCall("Z".repeat(43));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "This link is not valid." });
    });

    it("simulate in demo mode replays the fixture with the token and demo-<now> id", async () => {
      stubEnv(true);
      vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
      const res = await simulateCall();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PROCESSED);
      const data = m.process.mock.calls[0][0];
      expect(data.conversation_id).toBe("demo-1800000000000");
      expect(data.conversation_initiation_client_data.dynamic_variables.intake_token).toBe(TOKEN);
      expect(data.transcript).toEqual(fixture.data.transcript);
    });

    it("review without a brief -> 404; with a brief -> 200 { report } and brief.reviewed audit", async () => {
      m.markBriefReviewed.mockResolvedValueOnce(null);
      const missing = await reviewedCall(CASE.id);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "No brief for this case" });
      expect(m.audit).not.toHaveBeenCalled();

      const report = { id: "rep-1", status: "final" };
      m.markBriefReviewed.mockResolvedValueOnce(report);
      const res = await reviewedCall(CASE.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ report });
      expect(m.audit).toHaveBeenCalledWith(
        expect.objectContaining({ caseId: CASE.id, actor: "therapist", action: "brief.reviewed", entityId: "rep-1" }),
      );
    });
  });
});

// =============================================================================================
describe("E-3 client completion lifecycle (FR-12)", () => {
  type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
  const accepted = () => Response.json({ status: "processing" }, { status: 202 });
  const saved = () => Response.json({ received: true, case_id: "c", recording_id: "r", brief: true });

  function setup(responses: Array<() => Response | Promise<Response>>, fallback: () => Response = accepted) {
    const states: CompletionState[] = [];
    let i = 0;
    const fetchFn = vi.fn<FetchFn>(async () => (responses[i] ? responses[i++]() : fallback()));
    const poller = createCompletionPoller("tok", "conv_42", fetchFn, (s) => states.push(s));
    return { states, fetchFn, poller, last: () => states.at(-1) };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  it("posts the conversation id, retries every 3 s on 202, then shows the thank-you message", async () => {
    const t = setup([accepted, accepted, saved]);
    expect(t.poller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    expect(t.fetchFn).toHaveBeenCalledWith(
      "/api/intake/tok/complete",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ conversation_id: "conv_42" }) }),
    );
    expect(t.last()).toEqual({ kind: "saving" });
    expect(completionText(t.last()!)).toBe(MESSAGES.saving);
    expect(completionText(t.last()!)).not.toMatch(/thank you/i);

    await vi.advanceTimersByTimeAsync(COMPLETION_POLL_MS - 1);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(COMPLETION_POLL_MS);
    expect(t.fetchFn).toHaveBeenCalledTimes(3);
    expect(t.last()).toEqual({ kind: "done" });
    expect(completionText(t.last()!)).toBe("Call ended. Thank you! You can close this page.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchFn).toHaveBeenCalledTimes(3);
  });

  it("never overlaps requests: a slow request delays the next poll and start() is ignored while busy", async () => {
    let release: (r: Response) => void = () => {};
    const t = setup([() => new Promise<Response>((r) => (release = r)), saved]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    expect(t.poller.start()).toBe(false);
    release(accepted());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.poller.start()).toBe(false); // timer pending
    await vi.advanceTimersByTimeAsync(COMPLETION_POLL_MS);
    expect(t.fetchFn).toHaveBeenCalledTimes(2);
    expect(t.last()).toEqual({ kind: "done" });
  });

  it("times out after 120 s with an actionable error, then a retry completes without a second call", async () => {
    const t = setup([]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS + 10_000);
    expect(t.fetchFn).toHaveBeenCalledTimes(COMPLETION_TIMEOUT_MS / COMPLETION_POLL_MS + 1);
    expect(t.last()).toEqual({ kind: "error", message: MESSAGES.saveTimeout });
    expect(MESSAGES.saveTimeout).toMatch(/Try again/);
    expect(t.states.some((s) => s.kind === "done")).toBe(false);

    t.fetchFn.mockImplementationOnce(async () => saved());
    expect(t.poller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last()).toEqual({ kind: "done" });
    expect(t.fetchFn.mock.calls.at(-1)?.[0]).toBe("/api/intake/tok/complete");
  });

  it.each([
    ["502 failed call", () => Response.json({ error: "The call failed" }, { status: 502 })],
    ["500 save failure", () => Response.json({ error: "Could not save the call" }, { status: 500 })],
    ["403 mismatch", () => Response.json({ error: "x" }, { status: 403 })],
    ["200 ignored", () => Response.json({ received: true, ignored: "unknown token" })],
    ["network error", () => Promise.reject(new TypeError("offline"))],
  ])("%s -> actionable error, no success claim, retry allowed", async (_name, response) => {
    const t = setup([response, saved]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last()).toEqual({ kind: "error", message: MESSAGES.saveFailed });
    expect(MESSAGES.saveFailed).toMatch(/Try again/);
    expect(t.states.some((s) => s.kind === "done")).toBe(false);
    await vi.advanceTimersByTimeAsync(COMPLETION_POLL_MS * 2);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    expect(t.poller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.last()).toEqual({ kind: "done" });
  });

  it("cancel (unmount) stops the timer and ignores an in-flight answer", async () => {
    const t = setup([]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.poller.cancel();
    await vi.advanceTimersByTimeAsync(COMPLETION_TIMEOUT_MS);
    expect(t.fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    let release: (r: Response) => void = () => {};
    const u = setup([() => new Promise<Response>((r) => (release = r))]);
    u.poller.start();
    u.poller.cancel();
    release(saved());
    await vi.advanceTimersByTimeAsync(0);
    expect(u.states).toEqual([{ kind: "saving" }]);
    expect(u.poller.start()).toBe(false);
  });

  it("IntakeCall wiring: the id from onConnect is posted to the completion endpoint after disconnect", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async () => saved());
    vi.stubGlobal("fetch", fetchMock);
    renderToStaticMarkup(withI18n(createElement(IntakeCall, { token: "tok", childAlias: "Ravi", defaultLanguage: "te" })));
    const options = m.sdkOptions!;
    options.onDisconnect?.(); // never connected: nothing posted
    expect(fetchMock).not.toHaveBeenCalled();
    options.onConnect?.({ conversationId: "conv_live_1" });
    options.onDisconnect?.();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/intake/tok/complete");
    expect(JSON.parse(init.body as string)).toEqual({ conversation_id: "conv_live_1" });
  });
});

// =============================================================================================
describe("E-4 components (FR-7, FR-8)", () => {
  type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

  it("SimulateCallButton renders the demo button", () => {
    const html = renderToStaticMarkup(withI18n(createElement(SimulateCallButton, { token: "tok" })));
    expect(html).toContain(`>${SIMULATE_LABEL}</button>`);
    expect(SIMULATE_DONE).toBe("Call ended. Thank you! You can close this page.");
  });

  it("simulateIntake posts to the simulate endpoint and maps results", async () => {
    const ok = vi.fn<FetchFn>(async () => Response.json({ received: true, recording_id: "r", brief: true }));
    await expect(simulateIntake("tok", ok)).resolves.toEqual({ ok: true });
    expect(ok).toHaveBeenCalledWith("/api/dev/simulate-intake/tok", { method: "POST" });
    const bad = vi.fn<FetchFn>(async () => Response.json({ error: "This link is not valid." }, { status: 404 }));
    await expect(simulateIntake("tok", bad)).resolves.toEqual({ ok: false, message: "This link is not valid." });
    const down = vi.fn<FetchFn>(async () => {
      throw new TypeError("offline");
    });
    await expect(simulateIntake("tok", down)).resolves.toMatchObject({ ok: false });
  });

  const segments = [
    { id: "t8", speaker: "parent" as const, speaker_label: "user", start_sec: 42, end_sec: 50, text: "x" },
    { id: "t17", speaker: "parent" as const, speaker_label: "user", start_sec: 125, end_sec: 130, text: "y" },
  ];
  const render = (state: ReturnType<typeof briefStateFrom>) =>
    renderToStaticMarkup(createElement(BriefSection, { caseId: "c1", therapistName: "Dr. Demo", state }));

  it("brief: heading, Parent-reported badge, summary, red flags in red, numbered questions, table, review button", () => {
    const html = render(briefStateFrom({ recording: { segments }, report: { content: briefFixture, status: "draft" } }));
    expect(html).toContain("<h2");
    expect(html).toContain(">Pre-session brief</h2>");
    expect(html).toContain(">Parent-reported</span>");
    expect(html).toContain(briefFixture.summary.slice(0, 40));
    expect(html).toMatch(/text-red-700[^>]*><li>Lost speech: &quot;at age 2 he said a few words/);
    expect(html).toContain("&quot; at 00:42</li>");
    expect(html).toContain("Self-injury: &quot;he hits his own head with his hand when he is upset&quot; at 02:05");
    expect(html).toContain("Questions to verify");
    expect(html).toContain("<ol");
    expect(html).toContain("What the parent reported");
    expect(html).toContain("Age (months)</th><td");
    expect(html).toContain(">Mark brief reviewed</button>");
    expect(html).not.toContain("Reviewed by");
  });

  it("final brief: no review button, shows Reviewed by <therapist_name>", () => {
    const html = render(briefStateFrom({ recording: { segments }, report: { content: briefFixture, status: "final" } }));
    expect(html).toContain("Reviewed by Dr. Demo");
    expect(html).not.toContain("Mark brief reviewed");
  });

  it("intake without brief shows the failure message; no intake renders nothing", () => {
    expect(render({ kind: "failed" })).toContain(BRIEF_FAILED);
    expect(render({ kind: "none" })).toBe("");
  });

  it("review client posts to the reviewed endpoint and maps errors", async () => {
    const ok = vi.fn<FetchFn>(async () => Response.json({ report: {} }));
    await expect(reviewClient("c1", ok)).resolves.toEqual({ ok: true });
    expect(ok).toHaveBeenCalledWith("/api/cases/c1/brief/reviewed", { method: "POST" });
    const missing = vi.fn<FetchFn>(async () => Response.json({ error: "No brief for this case" }, { status: 404 }));
    await expect(reviewClient("c1", missing)).resolves.toEqual({ ok: false, message: "No brief for this case" });
  });
});

// =============================================================================================
describe.skipIf(!DB_TESTS)("database integration (CT_DB_TESTS=1, isolated a010 cases)", () => {
  type Sql = postgres.Sql;
  let sql: Sql;
  const createdCases: string[] = [];
  const conversationIds: string[] = [];
  let actual: {
    process: typeof import("@/lib/intake/process");
    queries: typeof import("@/lib/queries/intake");
    audit: typeof import("@/lib/audit");
  };

  beforeAll(async () => {
    actual = {
      process: await vi.importActual("@/lib/intake/process"),
      queries: await vi.importActual("@/lib/queries/intake"),
      audit: await vi.importActual("@/lib/audit"),
    };
    const { default: postgresClient } = await import("postgres");
    sql = postgresClient(process.env.DATABASE_URL!, { max: 2, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    if (createdCases.length) await sql`delete from cases where id in ${sql(createdCases)}`;
    if (conversationIds.length) {
      await sql`delete from audit_events where case_id is null and details->>'conversation_id' in ${sql(conversationIds)}`;
    }
    await sql?.end({ timeout: 5 });
    const shared = (globalThis as { __carethreadSql?: Sql }).__carethreadSql;
    await shared?.end({ timeout: 5 });
  });

  beforeEach(() => {
    vi.resetAllMocks();
    stubEnv(false);
    m.process.mockImplementation(actual.process.processPostCall);
    m.getCaseByToken.mockImplementation(actual.queries.getCaseByToken);
    m.markBriefReviewed.mockImplementation(actual.queries.markBriefReviewed);
    m.audit.mockImplementation(actual.audit.audit);
    m.generateJson.mockResolvedValue(briefFixture);
  });

  async function newCase(status = "booked") {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    await sql`
      insert into cases (org_id, id, child_alias, parent_alias, language, therapist_name, status, intake_token)
      values ('00000000-0000-4000-8000-00000000a001', ${id}, 'a010 Ravi (synthetic)', 'a010 Lakshmi (synthetic)', 'te', 'a010 Therapist', ${status}, ${token})`;
    createdCases.push(id);
    return { id, token };
  }
  const conv = (label: string) => {
    const id = `a010-${label}-${randomBytes(4).toString("hex")}`;
    conversationIds.push(id);
    return id;
  };
  async function counts(caseId: string) {
    const [row] = await sql<{ recordings: number; facts: number; reports: number; received: number; status: string }[]>`
      select
        (select count(*)::int from recordings where case_id = ${caseId} and kind = 'intake_call') as recordings,
        (select count(*)::int from facts where case_id = ${caseId} and instrument = 'CASE_SHEET') as facts,
        (select count(*)::int from reports where case_id = ${caseId} and kind = 'pre_session_brief') as reports,
        (select count(*)::int from audit_events where case_id = ${caseId} and action = 'intake.received') as received,
        (select status from cases where id = ${caseId}) as status`;
    return row;
  }
  const empty = { recordings: 0, facts: 0, reports: 0, received: 0, status: "booked" };

  it("E-1 signed webhook persists recording, 15 facts, brief, intake_done and receipt audit", async () => {
    const c = await newCase();
    const id = conv("webhook");
    const res = await signedWebhook({ type: "post_call_transcription", data: postCallData(c.token, id) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ received: true, case_id: c.id, brief: true });
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 1, received: 1, status: "intake_done" });

    const [rec] = await sql`select * from recordings where id = ${body.recording_id}`;
    expect(rec).toMatchObject({ kind: "intake_call", status: "transcribed", external_id: id });
    expect(Number(rec.duration_sec)).toBe(fixture.data.metadata.call_duration_secs);
    expect(rec.segments).toHaveLength(21);
    const facts = await sql`select * from facts where recording_id = ${body.recording_id}`;
    expect(facts.every((f) => f.source === "parent_call" && f.status === "suggested" && f.evidence === null)).toBe(true);
    const age = facts.find((f) => f.item_id === "child_age_months")!;
    expect([age.value, age.ai_value]).toEqual([40, 40]);
    const [report] = await sql`select * from reports where recording_id = ${body.recording_id}`;
    expect(report.status).toBe("draft");
    for (const heading of [
      "## Pre-session brief (parent-reported)",
      "### Red flags",
      "### Questions to verify",
      "### What the parent reported",
    ]) {
      expect(report.content_md).toContain(heading);
    }
    expect(report.content_md).toContain("Parent-reported");
    const [audit] = await sql`select * from audit_events where case_id = ${c.id} and action = 'intake.received'`;
    expect(audit.actor).toBe("parent");

    // E-1 duplicate delivery
    const again = await signedWebhook({ type: "post_call_transcription", data: postCallData(c.token, id) });
    expect([again.status, await again.json()]).toEqual([200, { received: true, duplicate: true }]);
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 1, received: 1, status: "intake_done" });
  });

  it("E-1 bad signatures write nothing; unknown token is ignored and audited", async () => {
    const c = await newCase();
    const body = JSON.stringify({ type: "post_call_transcription", data: postCallData(c.token, conv("badsig")) });
    for (const header of [null, "t=1,v0=00", signPayload(body, "wrong"), signPayload(body, SECRET, 1)]) {
      expect((await webhookCall(body, header)).status).toBe(401);
    }
    expect(await counts(c.id)).toEqual(empty);

    const unknownId = conv("unknown");
    const res = await signedWebhook({ type: "post_call_transcription", data: postCallData("a010-no-such-token", unknownId) });
    expect([res.status, await res.json()]).toEqual([200, { received: true, ignored: "unknown token" }]);
    const rows = await sql`
      select * from audit_events where action = 'intake.unknown_token' and details->>'conversation_id' = ${unknownId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].case_id).toBeNull();
    expect((await sql`select 1 from recordings where external_id = ${unknownId}`).length).toBe(0);
  });

  it("E-1 a fact insert failure rolls back recording, facts, case status and receipt audit", async () => {
    const c = await newCase();
    const data = postCallData(c.token, conv("rollback"));
    data.analysis.data_collection_results.main_concern.value = "broken \u0000 value"; // jsonb rejects NUL
    const res = await signedWebhook({ type: "post_call_transcription", data });
    expect(res.status).toBe(500);
    expect(await counts(c.id)).toEqual(empty);
    expect((await sql`select 1 from recordings where external_id = ${data.conversation_id}`).length).toBe(0);

    // The same conversation can be delivered again once the data is fixed.
    const fixed = postCallData(c.token, data.conversation_id);
    expect((await signedWebhook({ type: "post_call_transcription", data: fixed })).status).toBe(200);
    expect(await counts(c.id)).toMatchObject({ recordings: 1, facts: 15, received: 1, status: "intake_done" });
  });

  it("E-1 brief failure keeps recording and facts, returns brief: false and audits intake.brief_failed", async () => {
    const c = await newCase();
    m.generateJson.mockRejectedValue(new GeminiError("Gemini request failed: overloaded"));
    const res = await signedWebhook({ type: "post_call_transcription", data: postCallData(c.token, conv("nobrief")) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, case_id: c.id, brief: false });
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 0, received: 1, status: "intake_done" });
    const rows = await sql`select * from audit_events where case_id = ${c.id} and action = 'intake.brief_failed'`;
    expect(rows).toHaveLength(1);

    // E-4: the Brief tab state for this case is the failure message; reviewing it is 404.
    const intake = await actual.queries.getIntakeBrief(c.id);
    expect(briefStateFrom(intake)).toEqual({ kind: "failed" });
    expect((await reviewedCall(c.id)).status).toBe(404);
  });

  it("E-1 red flags citing unknown turn ids are dropped before saving", async () => {
    const c = await newCase();
    m.generateJson.mockResolvedValue({
      ...briefFixture,
      red_flags: [...briefFixture.red_flags, { type: "other", turn_id: "t99", quote: "invented" }],
    });
    const res = await signedWebhook({ type: "post_call_transcription", data: postCallData(c.token, conv("flags")) });
    const { recording_id } = await res.json();
    const [report] = await sql`select content from reports where recording_id = ${recording_id}`;
    expect(report.content.red_flags.map((f: { turn_id: string }) => f.turn_id)).toEqual(["t8", "t17"]);
  });

  it("E-2 completion: pending statuses and mismatches write nothing; done persists the same output", async () => {
    const c = await newCase();
    const id = conv("complete");
    for (const status of ["initiated", "in-progress", "processing"]) {
      m.getConversation.mockResolvedValueOnce({ ...postCallData(c.token, id), status });
      expect((await completeCall({ conversation_id: id }, c.token)).status).toBe(202);
    }
    m.getConversation.mockResolvedValueOnce({ ...postCallData(c.token, id), status: "done", agent_id: "agent_other" });
    expect((await completeCall({ conversation_id: id }, c.token)).status).toBe(403);
    m.getConversation.mockResolvedValueOnce({ ...postCallData("a010-other-token", id), status: "done" });
    expect((await completeCall({ conversation_id: id }, c.token)).status).toBe(403);
    m.getConversation.mockResolvedValueOnce({ ...postCallData(c.token, id), status: "failed" });
    expect((await completeCall({ conversation_id: id }, c.token)).status).toBe(502);
    expect(await counts(c.id)).toEqual(empty);

    m.getConversation.mockResolvedValueOnce({ ...postCallData(c.token, id), status: "done" });
    const res = await completeCall({ conversation_id: id }, c.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, case_id: c.id, brief: true });
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 1, received: 1, status: "intake_done" });
  });

  it("E-2 concurrent webhook and completion for the same conversation create one recording and one fact set", async () => {
    const c = await newCase();
    const id = conv("race");
    m.getConversation.mockResolvedValue({ ...postCallData(c.token, id), status: "done" });
    const [a, b] = await Promise.all([
      signedWebhook({ type: "post_call_transcription", data: postCallData(c.token, id) }),
      completeCall({ conversation_id: id }, c.token),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((x) => x.recording_id).length).toBe(1);
    expect(bodies.filter((x) => x.duplicate === true).length).toBe(1);
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 1, received: 1, status: "intake_done" });
  });

  it("E-2 five concurrent deliveries of the same conversation still produce no duplicate facts", async () => {
    const c = await newCase();
    const id = conv("race5");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => actual.process.processPostCall(postCallData(c.token, id))),
    );
    expect(results.filter((r) => "recording_id" in r).length).toBe(1);
    expect(results.filter((r) => "duplicate" in r).length).toBe(4);
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 1, received: 1, status: "intake_done" });
  });

  it("E-4 demo simulate completes the intake from the fixture; case status only moves from booked", async () => {
    stubEnv(true);
    const c = await newCase();
    const res = await simulateCall(c.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, case_id: c.id, brief: true });
    expect(await counts(c.id)).toEqual({ recordings: 1, facts: 15, reports: 1, received: 1, status: "intake_done" });

    const later = await newCase("in_assessment");
    await simulateCall(later.token);
    expect((await counts(later.id)).status).toBe("in_assessment");
  });

  it("E-4 review marks the brief final with updated_at and a brief.reviewed audit", async () => {
    const c = await newCase();
    await signedWebhook({ type: "post_call_transcription", data: postCallData(c.token, conv("review")) });
    const before = await sql`select updated_at from reports where case_id = ${c.id}`;
    const res = await reviewedCall(c.id);
    expect(res.status).toBe(200);
    const { report } = await res.json();
    expect(report.status).toBe("final");
    expect(new Date(report.updated_at).getTime()).toBeGreaterThan(new Date(before[0].updated_at).getTime());
    const rows = await sql`select * from audit_events where case_id = ${c.id} and action = 'brief.reviewed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("therapist");
    const noBrief = await newCase();
    expect((await reviewedCall(noBrief.id)).status).toBe(404);
  });
});
