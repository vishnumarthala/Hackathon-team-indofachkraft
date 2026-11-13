// 041 FR-8 / D-4: delete an ElevenLabs Conversational AI conversation (transcript + audio held by the processor)
// when a guardian's deletion request is executed. Server only.
// API: DELETE https://api.elevenlabs.io/v1/convai/conversations/{conversation_id} with `xi-api-key`.
// 200 -> deleted, 404 -> already gone (counts as done). Anything else is a failure that the privacy job retries.
// DEMO_MODE (or no API key): nothing leaves the app; the call is recorded as deleted with response code 200
// (`demo: true`), so the local flow and the processor log behave like production.
import { CONVERSATIONS_URL } from "@/lib/elevenlabs/agent";
import { env } from "@/lib/env";

export type ConversationDeleteOutcome = {
  status: "deleted" | "not_found" | "failed";
  responseCode: number | null;
  demo?: boolean;
};

export type ConversationDeleter = (conversationId: string) => Promise<ConversationDeleteOutcome>;

export function conversationUrl(conversationId: string): string {
  return `${CONVERSATIONS_URL}/${encodeURIComponent(conversationId)}`;
}

export const deleteConversation: ConversationDeleter = async (conversationId) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (env.DEMO_MODE || !apiKey) return { status: "deleted", responseCode: 200, demo: true };
  try {
    const res = await fetch(conversationUrl(conversationId), {
      method: "DELETE",
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { status: "deleted", responseCode: res.status };
    if (res.status === 404) return { status: "not_found", responseCode: 404 };
    return { status: "failed", responseCode: res.status };
  } catch {
    return { status: "failed", responseCode: null };
  }
};
