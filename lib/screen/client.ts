// Ticket 033: browser side of the check-in, free of React so it can be tested with mocks (E-3). The page component
// (components/screen/ScreenFlow.tsx) passes `fetch`, the microphone prompt and the ElevenLabs SDK's startSession.
import { LANGUAGE_UNAVAILABLE, responseLanguage } from "@/lib/agents/languages";
import type { ScreenDemoScript } from "@/lib/agents/screen/demo-script";
import type { RedFlagCode } from "@/lib/clinical/checkin";
import type { Locale } from "@/lib/i18n/config";
import { reportVoiceEnd, voiceStartHeaders } from "@/lib/voice/client";
import { voiceRefusal, type VoiceRefusal } from "@/lib/voice/constants";
import type { MatchResponse } from "./matches";
import type { QuestionAgeBand, ScreenConcern, ScreenMode, ScreenQuestion, ScreenResult } from "./questions";

export const SESSION_STORAGE_KEY = "dnm.screen.session";

export type StartedSession = { session_id: string; expires_at: string; questions: ScreenQuestion[] };

type VoiceTarget = { conversationToken: string } | { agentId: string; connectionType: "webrtc" };

/**
 * 051: a voice start refused by the cost guard maps to its own message; the tap path is always offered. 049:
 * `languageUnavailable` = the agent does not speak the requested language: the page offers "Voice in English" or tapping.
 */
export type StartError = "busy" | "voiceUnavailable" | "mic" | "failed" | "languageUnavailable" | Exclude<VoiceRefusal, "notAllowed">;

export type StartOutcome =
  | { kind: "form"; session: StartedSession }
  /** DEMO_MODE: no live call; the page runs the scripted voice check-in in the call language (049), or the form. */
  | { kind: "demo"; session: StartedSession; script: ScreenDemoScript | null }
  | {
      kind: "voice";
      session: StartedSession;
      target: VoiceTarget;
      dynamicVariables: Record<string, string>;
      /** 051 FR-7: the ledger row to report the end against, and the maximum call length. */
      usage: { id: string | null; maxSeconds: number | null };
      /** 049: the call language (`overrides.agent.language`). */
      language: Locale;
    }
  /** The session exists but the microphone was refused: continue by tapping. */
  | { kind: "micDenied"; session: StartedSession }
  | { kind: "error"; error: StartError };

export type StartDeps = {
  fetchFn: typeof fetch;
  getMicrophone?: () => Promise<{ getTracks?: () => Array<{ stop: () => void }> }>;
  /** 051 FR-8: the Cloudflare Turnstile token, when the page renders the widget (voice only). */
  turnstileToken?: string | null;
};

/**
 * POST /api/screen/sessions (048: with the parent's worries as codes; 049: voice with the call language), then (voice
 * only) the microphone prompt.
 */
export async function startScreen(
  ageBand: QuestionAgeBand,
  mode: ScreenMode,
  deps: StartDeps,
  concerns: readonly ScreenConcern[] = [],
  language?: Locale,
): Promise<StartOutcome> {
  let res: Response;
  try {
    res = await deps.fetchFn("/api/screen/sessions", {
      method: "POST",
      headers: voiceStartHeaders(mode === "voice" ? deps.turnstileToken : null),
      body: JSON.stringify({ age_band: ageBand, mode, concerns, ...(mode === "voice" && language ? { language } : {}) }),
    });
  } catch {
    return { kind: "error", error: "failed" };
  }
  if (mode === "voice" && res.status === 409) {
    const body = (await res.clone().json().catch(() => null)) as { error?: string } | null;
    if (body?.error === LANGUAGE_UNAVAILABLE) return { kind: "error", error: "languageUnavailable" };
  }
  if (mode === "voice" && !res.ok) {
    const refusal = voiceRefusal(res.status, await res.clone().json().catch(() => null));
    if (refusal && refusal !== "notAllowed") return { kind: "error", error: refusal };
  }
  if (res.status === 429) return { kind: "error", error: "busy" };
  if (mode === "voice" && (res.status === 502 || res.status === 503)) return { kind: "error", error: "voiceUnavailable" };
  if (!res.ok) return { kind: "error", error: "failed" };
  const body = (await res.json().catch(() => ({}))) as Partial<StartedSession> & {
    demo?: boolean;
    conversation_token?: string | null;
    agent_id?: string;
    dynamic_variables?: Record<string, string>;
    voice_usage_id?: string;
    max_seconds?: number;
    language?: string;
    demo_script?: ScreenDemoScript;
  };
  if (!body.session_id || !Array.isArray(body.questions)) return { kind: "error", error: "failed" };
  const session: StartedSession = { session_id: body.session_id, expires_at: body.expires_at ?? "", questions: body.questions };
  if (mode === "form") return { kind: "form", session };
  if (body.demo === true) return { kind: "demo", session, script: body.demo_script ?? null };

  const target: VoiceTarget | null = body.conversation_token
    ? { conversationToken: body.conversation_token }
    : body.agent_id
      ? { agentId: body.agent_id, connectionType: "webrtc" }
      : null;
  if (!target) return { kind: "error", error: "voiceUnavailable" };
  try {
    const stream = await deps.getMicrophone?.();
    // Only needed for the permission prompt; the SDK opens its own stream.
    stream?.getTracks?.().forEach((t) => t.stop());
  } catch {
    // 051: no call will happen; close the reservation (it still counts as a start, with 0 seconds).
    await reportVoiceEnd(deps.fetchFn, body.voice_usage_id, 0);
    return { kind: "micDenied", session };
  }
  return {
    kind: "voice",
    session,
    target,
    dynamicVariables: body.dynamic_variables ?? {},
    usage: { id: body.voice_usage_id ?? null, maxSeconds: body.max_seconds ?? null },
    language: responseLanguage(body),
  };
}

export type AnswerResponse =
  | { ok: true; missing: string[]; stop: boolean }
  | { ok: false; status: number; error: string };

export async function postAnswers(
  fetchFn: typeof fetch,
  sessionId: string,
  answers: { item_id: string; answer: string }[],
  conversationId?: string,
): Promise<AnswerResponse> {
  try {
    const res = await fetchFn(`/api/screen/sessions/${encodeURIComponent(sessionId)}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, ...(conversationId ? { conversation_id: conversationId } : {}) }),
    });
    const json = (await res.json().catch(() => ({}))) as { missing?: string[]; stop?: boolean; error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? "failed" };
    return { ok: true, missing: json.missing ?? [], stop: json.stop === true };
  } catch {
    return { ok: false, status: 0, error: "failed" };
  }
}

export async function postRedFlag(
  fetchFn: typeof fetch,
  sessionId: string,
  code: RedFlagCode,
  conversationId?: string,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchFn(`/api/screen/sessions/${encodeURIComponent(sessionId)}/red-flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, ...(conversationId ? { conversation_id: conversationId } : {}) }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export type FinishOutcome =
  | { ok: true; result: ScreenResult }
  | { ok: false; status: number; missing: string[] };

export async function finishScreen(fetchFn: typeof fetch, sessionId: string, conversationId?: string): Promise<FinishOutcome> {
  try {
    const res = await fetchFn(`/api/screen/sessions/${encodeURIComponent(sessionId)}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(conversationId ? { conversation_id: conversationId } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as ScreenResult & { details?: { missing?: string[] } };
    if (!res.ok) return { ok: false, status: res.status, missing: json.details?.missing ?? [] };
    return { ok: true, result: json };
  } catch {
    return { ok: false, status: 0, missing: [] };
  }
}

export type FollowUpOutcome = { ok: true; result: ScreenResult } | { ok: false; status: number; missing: string[] };

/** 048 FR-3: the optional M-CHAT-R/F Follow-Up answers (pass/fail per followed-up item), all at once. */
export async function postFollowUp(
  fetchFn: typeof fetch,
  sessionId: string,
  answers: { item_id: string; answer: string }[],
): Promise<FollowUpOutcome> {
  try {
    const res = await fetchFn(`/api/screen/sessions/${encodeURIComponent(sessionId)}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    const json = (await res.json().catch(() => ({}))) as ScreenResult & { details?: { missing?: string[] } };
    if (!res.ok) return { ok: false, status: res.status, missing: json.details?.missing ?? [] };
    return { ok: true, result: json };
  } catch {
    return { ok: false, status: 0, missing: [] };
  }
}

/** 048 FR-10: up to 3 matching providers with their next free slots (default origin: central Hyderabad). */
export async function fetchMatches(
  fetchFn: typeof fetch,
  sessionId: string,
  origin: { lat: number; lng: number } | null = null,
): Promise<MatchResponse | null> {
  const qs = origin ? `?${new URLSearchParams({ lat: origin.lat.toFixed(3), lng: origin.lng.toFixed(3) })}` : "";
  try {
    const res = await fetchFn(`/api/screen/sessions/${encodeURIComponent(sessionId)}/providers${qs}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as MatchResponse;
    return Array.isArray(body.providers) ? body : null;
  } catch {
    return null;
  }
}

// ---------- voice client tools (FR-3) ----------

/** What the agent hears back from a tool call: instructions to the model, English in every call language (049). */
export const TOOL_REPLIES = {
  saved: (remaining: number) => `Saved. ${remaining} question${remaining === 1 ? "" : "s"} left. Ask the next one.`,
  complete:
    "All questions are answered. Thank the parent, tell them the result is now on their screen with nearby specialists, and end the call.",
  stop: "Red flag recorded. Say the fixed safety message now and end the call. Do not ask any more questions.",
  invalid:
    "That answer was not saved. Use an item id from the list and one of the answers shown in brackets for that question (never, sometimes, often or always; yes or no for the safety and yes/no questions).",
  closed: "The check-in is closed. End the call politely.",
  failed: "Saving failed. Ask the same question again.",
} as const;

export type ToolEvents = {
  onAnswer?: (itemId: string, answer: string, missing: string[]) => void;
  /** A red flag: the page shows only the 108/112 message (FR-7). */
  onStop: () => void;
  /** Every question answered: the page finishes the check-in when the call ends. */
  onComplete: () => void;
};

const normalise = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** `record_answer({ item_id, answer })` and `record_red_flag({ code })` for `startSession({ clientTools })`. */
export function screenClientTools(
  sessionId: string,
  deps: { fetchFn: typeof fetch; conversationId?: () => string | undefined },
  events: ToolEvents,
) {
  const cid = () => {
    try {
      return deps.conversationId?.() || undefined;
    } catch {
      return undefined;
    }
  };
  return {
    record_answer: async (params: { item_id?: unknown; answer?: unknown }): Promise<string> => {
      const itemId = typeof params?.item_id === "string" ? params.item_id.trim() : "";
      const answer = normalise(params?.answer);
      const saved = await postAnswers(deps.fetchFn, sessionId, [{ item_id: itemId, answer }], cid());
      if (!saved.ok) {
        if (saved.status === 400) return TOOL_REPLIES.invalid;
        if (saved.status === 409 && saved.error === "This check-in was stopped") {
          events.onStop();
          return TOOL_REPLIES.stop;
        }
        if (saved.status === 404 || saved.status === 409 || saved.status === 410) return TOOL_REPLIES.closed;
        return TOOL_REPLIES.failed;
      }
      events.onAnswer?.(itemId, answer, saved.missing);
      if (saved.stop) {
        events.onStop();
        return TOOL_REPLIES.stop;
      }
      if (saved.missing.length === 0) {
        events.onComplete();
        return TOOL_REPLIES.complete;
      }
      return TOOL_REPLIES.saved(saved.missing.length);
    },
    record_red_flag: async (params: { code?: unknown }): Promise<string> => {
      const code = normalise(params?.code) as RedFlagCode;
      // Stop on screen first: safety does not wait for the network.
      events.onStop();
      const saved = await postRedFlag(deps.fetchFn, sessionId, code, cid());
      if (!saved.ok && saved.status === 400) {
        // Unknown code: still a safety stop; store it under the general safety concern.
        await postRedFlag(deps.fetchFn, sessionId, "safety_concern", cid());
      }
      return TOOL_REPLIES.stop;
    },
  };
}

// ---------- saving to a child (FR-8) ----------

export type SaveOutcome =
  | { kind: "saved" }
  | { kind: "consent" }
  | { kind: "signIn" }
  | { kind: "error"; error: "expired" | "notSavable" | "failed" };

export async function saveToChild(fetchFn: typeof fetch, sessionId: string, childId: string): Promise<SaveOutcome> {
  try {
    const res = await fetchFn("/api/family/screen-results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, child_id: childId }),
    });
    if (res.ok) return { kind: "saved" };
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 422 && json.error === "Guardian consent required") return { kind: "consent" };
    if (res.status === 401) return { kind: "signIn" };
    if (res.status === 410) return { kind: "error", error: "expired" };
    if (res.status === 409) return { kind: "error", error: "notSavable" };
    return { kind: "error", error: "failed" };
  } catch {
    return { kind: "error", error: "failed" };
  }
}

export type AllowOutcome = "allowed" | "verifyPhone" | "outdated" | "failed";

/** 020 digital consent for `screen_result_save` (the exact text shown in the dialog). */
export async function allowScreenSave(fetchFn: typeof fetch, childId: string, documentId: string): Promise<AllowOutcome> {
  try {
    const res = await fetchFn(`/api/family/children/${encodeURIComponent(childId)}/consents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature: "screen_result_save", consent_document_id: documentId, agree: true }),
    });
    if (res.ok) return "allowed";
    if (res.status === 422) return "verifyPhone";
    if (res.status === 409) return "outdated";
    return "failed";
  } catch {
    return "failed";
  }
}
