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
