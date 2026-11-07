import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real SDK opens WebRTC connections; the component only needs its hook and provider.
const sdk = vi.hoisted(() => ({
  status: "disconnected" as string,
  startSession: vi.fn(),
  endSession: vi.fn(),
}));
vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: sdk.status, startSession: sdk.startSession, endSession: sdk.endSession }),
}));

import { CONSENT_LABEL, IntakeCall, MESSAGES, startIntakeCall, statusText, type StartDeps } from "@/components/intake/IntakeCall";
import { emailStatusText } from "@/components/intake/IntakeLinkCard";

function deps(response: Response | Error, mic: "ok" | "denied" = "ok") {
  const stop = vi.fn();
  const d = {
    fetchFn: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
    getMicrophone: vi.fn(async () => {
      if (mic === "denied") throw new DOMException("denied", "NotAllowedError");
      return { getTracks: () => [{ stop }] };
    }),
    startSession: vi.fn(),
    onSdkError: vi.fn(),
  };
  return { d: d as unknown as StartDeps & typeof d, stop };
}

const liveBody = {
  conversation_token: "tok",
  agent_id: "agent_x",
  dynamic_variables: { intake_token: "t", child_alias: "Ravi", parent_alias: "Lakshmi", therapist_name: "Demo", language: "te" },
};

describe("startIntakeCall", () => {
  it.each(["en", "hi", "te"] as const)("posts the chosen language %s to the start endpoint", async (language) => {
    const { d } = deps(Response.json({ demo: true }));
    await startIntakeCall("tok_en", language, d);
    expect(d.fetchFn).toHaveBeenCalledWith("/api/intake/tok_en/start", expect.objectContaining({ method: "POST" }));
    const init = d.fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init[1].body as string)).toEqual({ language });
  });

  it("demo mode: no microphone request and no SDK session", async () => {
    const { d } = deps(Response.json({ demo: true }));
    await expect(startIntakeCall("t", "te", d)).resolves.toEqual({ kind: "demo" });
    expect(d.getMicrophone).not.toHaveBeenCalled();
    expect(d.startSession).not.toHaveBeenCalled();
  });

  it("shows the API error text for a non-2xx answer", async () => {
    const { d } = deps(Response.json({ error: "This intake call is already complete" }, { status: 409 }));
    await expect(startIntakeCall("t", "en", d)).resolves.toEqual({
      kind: "error",
      message: "This intake call is already complete",
    });
    expect(d.getMicrophone).not.toHaveBeenCalled();
  });

  it("network failure gives a generic error", async () => {
    const { d } = deps(new TypeError("offline"));
    await expect(startIntakeCall("t", "en", d)).resolves.toEqual({ kind: "error", message: MESSAGES.startFailed });
  });

  it("microphone denied: specified message, no SDK session", async () => {
    const { d } = deps(Response.json(liveBody), "denied");
    await expect(startIntakeCall("t", "te", d)).resolves.toEqual({ kind: "error", message: MESSAGES.mic });
    expect(d.startSession).not.toHaveBeenCalled();
  });

  it("live: asks for the mic, releases it, and starts the session with token, variables and language override", async () => {
    const { d, stop } = deps(Response.json(liveBody));
    await expect(startIntakeCall("t", "te", d)).resolves.toEqual({ kind: "started" });
    expect(d.getMicrophone).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    expect(d.startSession).toHaveBeenCalledWith({
      conversationToken: "tok",
      dynamicVariables: liveBody.dynamic_variables,
      overrides: { agent: { language: "te" } },
      onError: d.onSdkError,
    });
  });

  it("SDK throwing on start reports the call failure", async () => {
    const { d } = deps(Response.json(liveBody));
    d.startSession.mockImplementation(() => {
      throw new Error("webrtc");
    });
    await expect(startIntakeCall("t", "en", d)).resolves.toEqual({ kind: "error", message: MESSAGES.failed });
  });
});

describe("statusText", () => {
  it("follows the SDK status", () => {
    expect(statusText("connecting", false)).toBe("Connecting…");
    expect(statusText("connected", true)).toBe("Connected - speak now");
    expect(statusText("disconnected", true)).toBe("Call ended. Thank you! You can close this page.");
    expect(statusText("disconnected", false)).toBeNull();
  });
});

describe("IntakeCall markup", () => {
  const render = () =>
    renderToStaticMarkup(createElement(IntakeCall, { token: "t", childAlias: "Ravi", defaultLanguage: "te" }));

  it("shows heading, disclosure, language select defaulting to the case language, consent and a disabled Start", () => {
    sdk.status = "disconnected";
    const html = render();
    expect(html).toContain("Intake call for Ravi&#x27;s family");
    expect(html).toContain(
      "You will talk to an AI assistant, not a person. It asks about Ravi&#x27;s development so the therapist is prepared. The call takes up to 15 minutes and is recorded and summarised for the therapist.",
    );
    expect(html).toContain('<label for="intake-language"');
    expect(html).toMatch(/<option value="en">English<\/option>/);
    expect(html).toMatch(/<option value="hi">हिन्दी \(Hindi\)<\/option>/);
    expect(html).toMatch(/<option value="te" selected="">తెలుగు \(Telugu\)<\/option>/);
    expect(html).toContain(CONSENT_LABEL);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*min-h-12[^>]*>Start call<\/button>/);
  });

  it("connected: shows the status and an End call button instead of Start", () => {
    sdk.status = "connected";
    const html = render();
    expect(html).toContain("Connected - speak now");
    expect(html).toContain("End call");
    expect(html).not.toContain("Start call");
  });

  it("connecting: shows Connecting…", () => {
    sdk.status = "connecting";
    expect(render()).toContain("Connecting…");
  });
});

describe("emailStatusText", () => {
  const share = { url: "u", whatsapp_url: "w" };
  it("maps responses to the FR-1 statuses", () => {
    expect(emailStatusText({ ok: true, body: { ...share, emailed: true } })).toBe("Email sent");
    expect(emailStatusText({ ok: true, body: { ...share, emailed: false } })).toBe("Email not sent (demo mode)");
    expect(emailStatusText({ ok: true, body: { ...share, emailed: false, email_error: "Email could not be sent" } })).toBe(
      "Email could not be sent",
    );
    expect(emailStatusText({ ok: false, body: { ...share, error: "Add a parent email first" } })).toBe(
      "Add a parent email first",
    );
  });
});
