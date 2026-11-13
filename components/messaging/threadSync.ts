// Ticket 027 FR-5: keeps a thread page (or a thread list) up to date. Realtime is a progressive enhancement:
// while the Supabase Realtime channel is SUBSCRIBED, changes trigger a refresh through the API (which re-checks
// access) and a slow check still notices revocation (Realtime just stops sending events to a user who lost
// access). When Realtime is unavailable (no subscription, CHANNEL_ERROR, TIMED_OUT, CLOSED or no answer in time)
// the page polls every 15 s. Any refresh that answers "lost" (404) stops everything: the page then shows
// `You no longer have access to this conversation.` Pure (timers injectable) so it is unit-tested.
import { LIVE_CHECK_INTERVAL_MS, POLL_INTERVAL_MS } from "@/lib/messaging/constants";

export type SyncStatus = "connecting" | "live" | "polling" | "lost";
export type RefreshResult = "ok" | "lost" | "error";
export type ChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

export type Subscribe = (handlers: { onChange: () => void; onStatus: (status: ChannelStatus) => void }) => (() => void) | null;

export type Timers = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export type SyncOptions = {
  refresh: () => Promise<RefreshResult>;
  subscribe?: Subscribe | null;
  onStatus?: (status: SyncStatus) => void;
  pollMs?: number;
  liveCheckMs?: number;
  /** How long to wait for SUBSCRIBED before polling instead. */
  connectTimeoutMs?: number;
  timers?: Timers;
};

const defaultTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

export function startThreadSync(options: SyncOptions): { stop: () => void; refreshNow: () => Promise<void>; status: () => SyncStatus } {
  const timers = options.timers ?? defaultTimers;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const liveCheckMs = options.liveCheckMs ?? LIVE_CHECK_INTERVAL_MS;
  let status: SyncStatus = "connecting";
  let interval: unknown = null;
  let connectTimer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const setStatus = (next: SyncStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };
  const clearTimers = () => {
    if (interval !== null) timers.clearInterval(interval);
    if (connectTimer !== null) timers.clearTimeout(connectTimer);
    interval = null;
    connectTimer = null;
  };
  const dropChannel = () => {
    const off = unsubscribe;
    unsubscribe = null;
    off?.();
  };
  const stop = () => {
    stopped = true;
    clearTimers();
    dropChannel();
  };

  const refreshNow = async () => {
    if (stopped) return;
    let result: RefreshResult;
    try {
      result = await options.refresh();
    } catch {
      result = "error";
    }
    if (result === "lost" && !stopped) {
      stop();
      setStatus("lost");
    }
  };

  const every = (ms: number) => {
    if (interval !== null) timers.clearInterval(interval);
    interval = timers.setInterval(() => void refreshNow(), ms);
  };

  const fallBackToPolling = () => {
    if (stopped || status === "polling") return;
    if (connectTimer !== null) timers.clearTimeout(connectTimer);
    connectTimer = null;
    // Stops the Realtime client's reconnect attempts (it disconnects once no channel is left).
    dropChannel();
    setStatus("polling");
    every(pollMs);
  };

  const onStatus = (channel: ChannelStatus) => {
    if (stopped) return;
    if (channel === "SUBSCRIBED") {
      if (connectTimer !== null) timers.clearTimeout(connectTimer);
      connectTimer = null;
      setStatus("live");
      every(liveCheckMs);
      // Catch up on anything sent while connecting.
      void refreshNow();
      return;
    }
    // An error may also mean the session lost access: check through the API first, then poll.
    void refreshNow().then(() => fallBackToPolling());
  };

  try {
    unsubscribe = options.subscribe ? options.subscribe({ onChange: () => void refreshNow(), onStatus }) : null;
  } catch {
    unsubscribe = null;
  }
  if (!unsubscribe) fallBackToPolling();
  else connectTimer = timers.setTimeout(fallBackToPolling, options.connectTimeoutMs ?? 10_000);

  return { stop, refreshNow, status: () => status };
}
