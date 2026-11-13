// Ticket 027 FR-5: Supabase Realtime subscription for the browser (anon key + the user's session; RLS decides
// which rows reach the user, see docs/messaging.md). Used only as a change signal: data is then fetched through
// the API, which re-checks access. Returns null (-> polling) when the browser client is not configured.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase-browser";
import type { ChannelStatus, Subscribe } from "./threadSync";

const STATUSES: readonly string[] = ["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"];

export function messagesSubscription(opts: { threadId?: string; events?: "INSERT" | "*" } = {}): Subscribe {
  return ({ onChange, onStatus }) => {
    let client: SupabaseClient;
    try {
      client = supabaseBrowser();
    } catch {
      return null;
    }
    const name = `messages:${opts.threadId ?? "inbox"}:${Math.random().toString(36).slice(2, 10)}`;
    const channel: RealtimeChannel = client
      .channel(name)
      .on(
        "postgres_changes",
        {
          event: opts.events ?? "*",
          schema: "public",
          table: "messages",
          ...(opts.threadId ? { filter: `thread_id=eq.${opts.threadId}` } : {}),
        },
        () => onChange(),
      )
      .subscribe((status) => {
        if (STATUSES.includes(status)) onStatus(status as ChannelStatus);
      });
    return () => {
      void client.removeChannel(channel);
    };
  };
}
