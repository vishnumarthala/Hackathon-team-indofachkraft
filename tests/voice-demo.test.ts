import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ startAgentSession: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/elevenlabs/agent", () => ({ startAgentSession: m.startAgentSession, DEMO_CENTRE_NAME: "CareThread Demo Centre" }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn() }),
}));

import { POST } from "@/app/api/demo/voice-token/route";
import { SAMPLE_CALL, SAMPLE_CALL_DURATION } from "@/components/landing/sampleCall";
import {
  DEMO_CALL_LIMIT_SEC,
  LIVE_MESSAGES,
  VoiceDemo,
  activeTurnIndex,
  cleanAgentText,
  formatCountdown,
  upsertLine,
  liveStatusText,
  startVoiceDemo,
  type DemoStartDeps,
} from "@/components/landing/VoiceDemo";
import { allowVoiceDemo, GLOBAL_LIMIT, PER_IP_LIMIT, PER_IP_WINDOW_MS, resetVoiceDemoLimits } from "@/lib/voiceDemoLimit";

const SECRET = "sk_test_secret_value";
const req = (ip = "203.0.113.7") => new Request("http://x/api/demo/voice-token", { method: "POST", headers: { "x-forwarded-for": ip } });

beforeEach(() => {
  vi.resetAllMocks();
  resetVoiceDemoLimits();
  vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_test");
  vi.stubEnv("ELEVENLABS_API_KEY", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/demo/voice-token", () => {
  it("returns the session and only synthetic, server-side variables", async () => {
    m.startAgentSession.mockResolvedValue({ agent_id: "agent_test", conversation_token: "tok" });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      agent_id: "agent_test",
      conversation_token: "tok",
      dynamic_variables: {
        parent_name: "Lakshmi",
        child_name: "Ravi",
        centre_name: "CareThread Demo Centre",
        therapist_name: "Demo Therapist",
        case_id: "landing-demo",
      },
    });
    expect(text).not.toContain(SECRET);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "landing.voice_demo_started", actor: "system" }));
  });

  it("503 without an agent id", async () => {
    vi.stubEnv("ELEVENLABS_AGENT_ID", "");
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Live demo unavailable" });
    expect(m.startAgentSession).not.toHaveBeenCalled();
  });

  it("429 after the per-visitor limit", async () => {
    m.startAgentSession.mockResolvedValue({ agent_id: "agent_test", conversation_token: null });
    for (let i = 0; i < PER_IP_LIMIT; i++) expect((await POST(req())).status).toBe(200);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/busy/);
    expect((await POST(req("198.51.100.2"))).status).toBe(200);
  });

  it("502 when ElevenLabs fails, without details", async () => {
    m.startAgentSession.mockRejectedValue(new Error(`boom ${SECRET}`));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(SECRET);
  });
});

describe("allowVoiceDemo", () => {
  it("frees a visitor's slots after the window and caps the global total", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < PER_IP_LIMIT; i++) expect(allowVoiceDemo("a", t0)).toBe(true);
    expect(allowVoiceDemo("a", t0 + 1)).toBe(false);
    expect(allowVoiceDemo("a", t0 + PER_IP_WINDOW_MS + 1)).toBe(true);
    resetVoiceDemoLimits();
    for (let i = 0; i < GLOBAL_LIMIT; i++) expect(allowVoiceDemo(`ip${i}`, t0)).toBe(true);
    expect(allowVoiceDemo("new-visitor", t0)).toBe(false);
  });
});

function deps(response: Response | Error, mic: "ok" | "denied" = "ok") {
  const order: string[] = [];
  const d = {
    getMicrophone: vi.fn(async () => {
      order.push("mic");
      if (mic === "denied") throw new Error("denied");
      return { getTracks: () => [{ stop: () => order.push("stop") }] };
    }),
    fetchFn: vi.fn(async () => {
      order.push("fetch");
      if (response instanceof Error) throw response;
      return response;
    }),
    startSession: vi.fn(() => order.push("session")),
  };
  return { d: d as unknown as DemoStartDeps & typeof d, order };
}

describe("startVoiceDemo", () => {
  const vars = { parent_name: "Lakshmi", child_name: "Ravi", centre_name: "C", therapist_name: "T", case_id: "x" };

  it("asks for the microphone before spending credits, then starts with the token and language", async () => {
    const { d, order } = deps(Response.json({ agent_id: "a", conversation_token: "tok", dynamic_variables: vars }));
    await expect(startVoiceDemo("te", d)).resolves.toEqual({ kind: "started" });
    expect(order).toEqual(["mic", "stop", "fetch", "session"]);
    expect(d.startSession).toHaveBeenCalledWith({ conversationToken: "tok", dynamicVariables: vars, overrides: { agent: { language: "te" } } });
  });

  it("public agent: starts by agent id over WebRTC", async () => {
    const { d } = deps(Response.json({ agent_id: "agent_pub", conversation_token: null, dynamic_variables: vars }));
    await startVoiceDemo("en", d);
    expect(d.startSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent_pub", connectionType: "webrtc" }));
  });

  it("maps failures to friendly messages", async () => {
    expect(await startVoiceDemo("en", deps(Response.json({}), "denied").d)).toEqual({ kind: "error", message: LIVE_MESSAGES.mic });
    expect(await startVoiceDemo("en", deps(new Response("", { status: 429 })).d)).toEqual({ kind: "error", message: LIVE_MESSAGES.busy });
    expect(await startVoiceDemo("en", deps(new Response("", { status: 503 })).d)).toEqual({ kind: "error", message: LIVE_MESSAGES.unavailable });
    expect(await startVoiceDemo("en", deps(new TypeError("offline")).d)).toEqual({ kind: "error", message: LIVE_MESSAGES.failed });
    expect(await startVoiceDemo("en", deps(Response.json({})).d)).toEqual({ kind: "error", message: LIVE_MESSAGES.failed });
  });

  it("denied microphone never calls the server", async () => {
    const { d } = deps(Response.json({}), "denied");
    await startVoiceDemo("en", d);
    expect(d.fetchFn).not.toHaveBeenCalled();
  });
});

describe("live transcript lines", () => {
  it("keeps the parent's line when the agent's reply shares its event_id", () => {
    let lines = upsertLine([], "agent", 1, "[warmly] Is that okay with you?");
    lines = upsertLine(lines, "user", 2, "Yes, that is fine.");
    lines = upsertLine(lines, "agent", 2, "[warmly] Thank you. How old is Ravi?");
    expect(lines).toEqual([
      { key: "agent-1", role: "agent", text: "Is that okay with you?" },
      { key: "parent-2", role: "parent", text: "Yes, that is fine." },
      { key: "agent-2", role: "agent", text: "Thank you. How old is Ravi?" },
    ]);
  });

  it("replaces a corrected agent line and ignores empty messages", () => {
    let lines = upsertLine([], "agent", 3, "He is three");
    lines = upsertLine(lines, "agent", 3, "He is three years old.");
    lines = upsertLine(lines, "user", 4, "   ");
    expect(lines).toEqual([{ key: "agent-3", role: "agent", text: "He is three years old." }]);
  });

  it("strips audio tags but keeps real brackets-free text", () => {
    expect(cleanAgentText("[warmly] Thank you, [softly] take your time.")).toBe("Thank you, take your time.");
    expect(cleanAgentText("No tags here.")).toBe("No tags here.");
  });
});

describe("helpers", () => {
  it("status text, countdown and the 3-minute cap", () => {
    expect(liveStatusText("connecting", false, false)).toBe("Connecting…");
    expect(liveStatusText("connected", true, true)).toBe(LIVE_MESSAGES.speaking);
    expect(liveStatusText("connected", false, true)).toBe(LIVE_MESSAGES.listening);
    expect(liveStatusText("disconnected", false, true)).toBe(LIVE_MESSAGES.ended);
    expect(liveStatusText("disconnected", false, false)).toBeNull();
    expect(DEMO_CALL_LIMIT_SEC).toBe(180);
    expect(formatCountdown(180)).toBe("3:00");
    expect(formatCountdown(65.2)).toBe("1:06");
    expect(formatCountdown(-3)).toBe("0:00");
  });

  it("sample call: ordered turns that start with the AI disclosure and fit the audio", () => {
    expect(SAMPLE_CALL[0].role).toBe("agent");
    expect(SAMPLE_CALL[0].text).toContain("I am an AI assistant");
    expect(SAMPLE_CALL.some((t) => /hits his own head/.test(t.text))).toBe(true);
    for (let i = 1; i < SAMPLE_CALL.length; i++) expect(SAMPLE_CALL[i].start).toBeGreaterThanOrEqual(SAMPLE_CALL[i - 1].end);
    expect(SAMPLE_CALL.at(-1)!.end).toBeLessThanOrEqual(SAMPLE_CALL_DURATION);
    expect(activeTurnIndex(SAMPLE_CALL, 0)).toBe(-1);
    expect(activeTurnIndex(SAMPLE_CALL, SAMPLE_CALL[2].start + 0.1)).toBe(2);
  });

  it("renders both tabs with the sample call first", () => {
    const html = renderToStaticMarkup(createElement(VoiceDemo));
    expect(html).toContain("Listen to a sample call");
    expect(html).toContain("Talk to it live");
    expect(html).toContain('src="/landing/sample-intake-call.mp3"');
    expect(html).toContain("I am an AI assistant");
  });
});
