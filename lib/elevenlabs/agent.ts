import { env } from "@/lib/env";

export const CONVERSATION_TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";

export class TokenRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

// Server only: issues a short-lived WebRTC conversation token for the private intake agent (035: or another agent).
export async function getConversationToken(agentId: string = env.ELEVENLABS_AGENT_ID): Promise<string> {
  const url = `${CONVERSATION_TOKEN_URL}?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(url, { method: "GET", headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
  if (!res.ok) throw new TokenRequestError(`Conversation token request failed (HTTP ${res.status})`, res.status);
  const json = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (!json || typeof json.token !== "string" || json.token === "") {
    throw new TokenRequestError("Conversation token response had no token", null);
  }
  return json.token;
}

export type AgentStart = { agent_id: string; conversation_token: string | null };

// Statuses meaning "this key may not mint tokens for this agent" (e.g. the agent lives in another
// workspace). A public agent (authentication off) can still be started by its ID from the browser.
const PUBLIC_FALLBACK_STATUSES = new Set([401, 403, 404]);

// Server only. Returns a conversation token when possible, otherwise the agent ID for a public start.
// Throws when no agent is configured, or on other provider failures (network, 5xx).
// 035: `agentId` selects another agent (the generic pre-consult intake agent); default the Child Development one.
export async function startAgentSession(agentId: string = env.ELEVENLABS_AGENT_ID): Promise<AgentStart> {
  if (!process.env.ELEVENLABS_API_KEY) return { agent_id: agentId, conversation_token: null };
  try {
    return { agent_id: agentId, conversation_token: await getConversationToken(agentId) };
  } catch (err) {
    if (err instanceof TokenRequestError && err.status !== null && PUBLIC_FALLBACK_STATUSES.has(err.status)) {
      return { agent_id: agentId, conversation_token: null };
    }
    throw err;
  }
}

// Dynamic variables the published DoctorNearMe intake agent requires (a missing one fails the start).
export type AgentVariables = {
  parent_name: string;
  child_name: string;
  centre_name: string;
  therapist_name: string;
  case_id: string;
};

export const DEMO_CENTRE_NAME = "DoctorNearMe Demo Centre";

export const CONVERSATIONS_URL = "https://api.elevenlabs.io/v1/convai/conversations";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

// Server only (010 FR-11): the finished-call record for a conversation. Throws ProviderError on network
// errors, non-2xx answers and non-object bodies; the caller validates the shape.
export async function getConversation(conversationId: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${CONVERSATIONS_URL}/${encodeURIComponent(conversationId)}`, {
      method: "GET",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
      cache: "no-store",
    });
  } catch (err) {
    throw new ProviderError(`Conversation request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new ProviderError(`Conversation request failed (HTTP ${res.status})`);
  const json = (await res.json().catch(() => null)) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ProviderError("Conversation response was not a JSON object");
  }
  return json as Record<string, unknown>;
}
