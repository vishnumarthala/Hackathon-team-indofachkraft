// Swap speakers -> re-run extraction (008 FR-7), free of React so the state rules can be unit tested.
import { NETWORK_ERROR } from "./uploadFlow";

// idle: nothing running. working: swap or extraction in flight. cleared: speakers are swapped and the
// old ratings are gone, but the new extraction has not succeeded, so the form must show nothing.
export type SwapPhase = "idle" | "working" | "cleared";

export type CallResult = { ok: boolean; status: number; error: string };
export type Call = (url: string, method: string, body: unknown) => Promise<CallResult>;

// reload: the page must be reloaded to show the server state (success, or an unknown outcome).
export type SwapOutcome = { phase: SwapPhase; error: string | null; reload: boolean };

export async function browserCall(url: string, method: string, body: unknown): Promise<CallResult> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, error: typeof json.error === "string" ? json.error : `Request failed (${res.status})` };
  } catch {
    return { ok: false, status: 0, error: NETWORK_ERROR };
  }
}

export async function reExtract(recordingId: string, call: Call): Promise<SwapOutcome> {
  const res = await call(`/api/sessions/${recordingId}/extract`, "POST", {});
  if (res.ok) return { phase: "idle", error: null, reload: true };
  return { phase: "cleared", error: res.error, reload: false };
}

export async function swapAndExtract(
  recordingId: string,
  call: Call,
  onSwapped: () => void,
): Promise<SwapOutcome> {
  const res = await call(`/api/sessions/${recordingId}/speakers`, "PATCH", { swap: true });
  if (!res.ok) {
    // 404/409: nothing changed. Anything else (network, 5xx): the swap may have committed, so show the server state.
    const unchanged = res.status === 404 || res.status === 409;
    return { phase: "idle", error: res.error, reload: !unchanged };
  }
  onSwapped();
  return reExtract(recordingId, call);
}
