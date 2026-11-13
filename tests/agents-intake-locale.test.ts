// Ticket 049: Telugu and Hindi for the generic pre-consult intake agent (035). Pure: prompts and first messages per
// language (FR-2), the start request carries the call language and the browser sends the language override only for
// Hindi/Telugu (FR-1), a language the agent does not have shows "Voice in English" or "Skip the call" (FR-4), and the
// scripted Hindi/Telugu demo calls (demo/fixtures/elevenlabs-generic-post-call.{hi,te}.json) produce the same
// data-collection codes as English (FR-3/FR-6: this agent has no tools; its structured output is the analysis).
// The route's 409 for a disabled language is covered in tests/appointment-intake.test.ts (database).
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IntakeCall, startIntakeCall, type StartDeps } from "@/components/intake/IntakeCall";
import { simulateIntake } from "@/components/intake/SimulateCallButton";
import { LANGUAGE_UNAVAILABLE, toAgentTemplate } from "@/lib/agents/languages";
import { AGENT_PROMPTS } from "@/lib/agents/prompts-all";
import type { Locale } from "@/lib/i18n/config";
import { demoAppointmentPostCall, genericPostCallFixture, parseAppointmentPostCall } from "@/lib/intake/appointment-process";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { withI18n } from "./helpers/i18n";

vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn(), getId: () => "" }),
}));

const CATALOGUES = { en, hi, te } as const;
const LANGS = ["en", "hi", "te"] as const satisfies readonly Locale[];
const fixture = (lang: Locale) =>
  JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures", genericPostCallFixture(lang)), "utf8")) as { data: Record<string, unknown> };

describe("FR-2: prompts and first messages per language (generic intake agent)", () => {
  it.each(LANGS)("%s: first message and safety message are the catalogue text", (lang) => {
    const p = AGENT_PROMPTS.generic_intake[lang];
    const m = CATALOGUES[lang].voiceAgents.genericIntake;
    expect(p.firstMessage).toBe(toAgentTemplate(m.firstMessage));
    expect(p.safetyMessage).toBe(m.safetyMessage);
    expect(p.systemPrompt).toContain(`stop the intake and say: "${m.safetyMessage}"`);
    expect(p.safetyMessage).toMatch(/108.*112/);
    for (const v of ["{{parent_name}}", "{{provider_name}}", "{{child_name}}"]) expect(p.firstMessage).toContain(v);
  });

  it("English is the dashboard text in docs/elevenlabs-generic-intake-agent.md", () => {
    const doc = readFileSync(path.join(process.cwd(), "docs/elevenlabs-generic-intake-agent.md"), "utf8");
    expect(doc).toContain(AGENT_PROMPTS.generic_intake.en.firstMessage);
    expect(doc).toContain(AGENT_PROMPTS.generic_intake.en.systemPrompt);
  });

  it.each(["hi", "te"] as const)("%s: same variables and consent-first rules; speaks the call language", (lang) => {
    const p = AGENT_PROMPTS.generic_intake[lang].systemPrompt;
    for (const token of ["{{child_name}}", "{{provider_name}}", "{{service_name}}", "{{parent_name}}", "{{language}}", "First get consent."]) expect(p).toContain(token);
    expect(p).toContain(lang === "te" ? "You speak Telugu (తెలుగు) only" : "You speak Hindi (हिन्दी) only");
  });
});

describe("FR-1 / FR-4: the generic intake call language in the browser", () => {
  const deps = (response: Response) =>
    ({
      fetchFn: vi.fn(async () => response),
      getMicrophone: vi.fn(async () => ({ getTracks: () => [] })),
      startSession: vi.fn(),
      onSdkError: vi.fn(),
    }) as unknown as StartDeps & { fetchFn: ReturnType<typeof vi.fn>; startSession: ReturnType<typeof vi.fn>; getMicrophone: ReturnType<typeof vi.fn> };
  const live = { conversation_token: "tok", agent_id: "agent_generic", language: "te", dynamic_variables: { intake_attempt_id: "a", language: "te" } };
  const opts = { apiBase: "/api/intake/a/tok", overrideLanguage: "non-english" as const };

  it("Telugu: the start request carries te and the call starts with the Telugu override", async () => {
    const d = deps(Response.json(live));
    await expect(startIntakeCall("tok", "te", d, undefined, opts)).resolves.toEqual({ kind: "started" });
    expect(JSON.parse((d.fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ language: "te" });
    expect(d.startSession).toHaveBeenCalledWith(expect.objectContaining({ conversationToken: "tok", overrides: { agent: { language: "te" } } }));
  });

  it("English: no override (the agent's base configuration)", async () => {
    const d = deps(Response.json({ ...live, language: "en" }));
    await startIntakeCall("tok", "en", d, undefined, opts);
    expect(d.startSession.mock.calls[0][0]).not.toHaveProperty("overrides");
  });

  it("409 language_unavailable -> no microphone, no call (the page shows the FR-4 choice)", async () => {
    const d = deps(Response.json({ error: LANGUAGE_UNAVAILABLE, details: { language: "te", enabled: ["en"] } }, { status: 409 }));
    await expect(startIntakeCall("tok", "te", d, undefined, opts)).resolves.toEqual({ kind: "languageUnavailable" });
    expect(d.getMicrophone).not.toHaveBeenCalled();
    expect(d.startSession).not.toHaveBeenCalled();
  });

  const page = (locale: Locale, voiceLanguages: Locale[]) =>
    renderToStaticMarkup(
      withI18n(
        createElement(IntakeCall, {
          token: "tok",
          childAlias: "Anaya (synthetic)",
          defaultLanguage: "en",
          apiBase: "/api/intake/a/tok",
          languageSelect: false,
          voiceLanguages,
          providerName: "Dr Rao (synthetic)",
          copy: { title: "Title", intro: "Intro", consent: "Consent" },
        }),
        locale,
      ),
    );

  it("FR-4 (rendered): Telugu page, agent only in English -> 'Voice in English' or 'Skip the call', no consent/start yet", () => {
    const html = page("te", ["en"]);
    expect(html).toContain(te.voiceAgents.fallback.intakeMessage.replace("{provider}", "Dr Rao (synthetic)"));
    expect(html).toContain(te.voiceAgents.fallback.voiceInEnglish);
    expect(html).toContain(te.voiceAgents.fallback.skipCall);
    expect(html).not.toContain("Consent");
    expect(html).not.toContain(`>${te.intake.start}<`);
  });

  it("native (rendered): the page says the assistant speaks Telugu and offers the normal start", () => {
    const html = page("te", ["en", "hi", "te"]);
    expect(html).toContain(te.voiceAgents.callLanguage.replace("{language}", te.voiceAgents.languages.te));
    expect(html).toContain("Consent");
    expect(html).not.toContain(te.voiceAgents.fallback.voiceInEnglish);
  });

  it("DEMO_MODE: the simulated call is replayed in the call language", async () => {
    const fetchFn = vi.fn(async () => Response.json({ received: true }));
    await simulateIntake("tok", fetchFn, { failed: "x" }, "/api/dev/simulate-intake/a/tok", "te");
    expect(fetchFn).toHaveBeenCalledWith("/api/dev/simulate-intake/a/tok", expect.objectContaining({ body: JSON.stringify({ language: "te" }) }));
  });
});

describe("FR-3 / FR-6: the scripted Hindi and Telugu intake calls give the same codes as English", () => {
  const attempt = { id: "00000000-0000-4000-8000-000000000049", agent_kind: "generic" as const };

  it.each(["hi", "te"] as const)("%s: same data-collection identifiers and values, same turn order, transcript in the language", (lang) => {
    const english = parseAppointmentPostCall({ ...fixture("en").data, conversation_initiation_client_data: { dynamic_variables: { intake_attempt_id: attempt.id } } });
    const local = parseAppointmentPostCall({ ...fixture(lang).data, conversation_initiation_client_data: { dynamic_variables: { intake_attempt_id: attempt.id } } });
    expect(local.analysis?.data_collection_results).toEqual(english.analysis?.data_collection_results);
    expect(local.transcript.map((t) => t.role)).toEqual(english.transcript.map((t) => t.role));
    const firstMessage = CATALOGUES[lang].voiceAgents.genericIntake.firstMessage
      .replace("{parent_name}", "Lakshmi (synthetic)")
      .replace("{child_name}", "Anaya (synthetic)")
      .replaceAll("{provider_name}", "Dr Rao (synthetic)");
    expect(local.transcript[0].message).toBe(firstMessage);
    const scriptRe = lang === "te" ? /[\u0c00-\u0c7f]/ : /[\u0900-\u097f]/;
    for (const turn of local.transcript) expect(turn.message ?? "").toMatch(scriptRe);
  });

  it("the DEMO_MODE replay picks the call language's fixture and passes the language with the attempt id", () => {
    const data = demoAppointmentPostCall(attempt, "conv-049", "te");
    expect(data.transcript[0].message).toContain("DoctorNearMe");
    expect(data.transcript[0].message).toMatch(/[\u0c00-\u0c7f]/);
    expect(data.conversation_initiation_client_data.dynamic_variables).toEqual({ intake_attempt_id: attempt.id, language: "te" });
    expect(demoAppointmentPostCall(attempt, "conv-049").transcript[0].message).toMatch(/^Hello/);
  });
});
