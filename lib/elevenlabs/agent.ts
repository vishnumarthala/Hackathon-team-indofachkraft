import { env } from "@/lib/env";

export const CONVERSATION_TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";

// Server only: issues a short-lived WebRTC conversation token for the private intake agent.
export async function getConversationToken(): Promise<string> {
  const url = `${CONVERSATION_TOKEN_URL}?agent_id=${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}`;
  const res = await fetch(url, { method: "GET", headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
  if (!res.ok) throw new Error(`Conversation token request failed (HTTP ${res.status})`);
  const json = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (!json || typeof json.token !== "string" || json.token === "") {
    throw new Error("Conversation token response had no token");
  }
  return json.token;
}

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
