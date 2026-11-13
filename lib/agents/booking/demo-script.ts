// Ticket 034 NFR-3: the DEMO_MODE scripted conversation. Runs in the browser and calls the same tool handlers as the
// real agent (through /api/agents/booking/demo/<tool>, cookie-bound). Pure apart from the injected `callTool` / `say`,
// so tests drive it directly. English only, like the agent; no names or contact details anywhere in the script.
import type { AgentTool } from "./constants";

export type ToolCaller = (tool: AgentTool, args: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
export type Speaker = (role: "agent" | "parent", text: string) => Promise<void> | void;

type Provider = { profile_id: string; name: string; locality: string | null; distance_km: number | null; modes: string[] };
type SlotOffer = { service_id: string; start: string; local_time: string };

export type DemoOutcome =
  | { kind: "held"; appointment_id: string; profile_id: string }
  | { kind: "no_providers" }
  | { kind: "no_slots" }
  | { kind: "error" };

export const DEMO_AREA = "Banjara Hills";

export const DEMO_LINES = {
  greeting:
    "Hello, I am DoctorNearMe's booking assistant. I am an AI. I can find a provider near you and hold a time for 10 minutes. Please do not tell me your child's name or any contact details. Which area are you in, and what kind of specialist do you need?",
  parentAsk: `A speech therapist near ${DEMO_AREA}, at the clinic, for my child aged 3 to 5.`,
  parentPickFirst: "The first one, please. Any morning this week.",
  parentPickTime: "The first time, please.",
  noProviders: "I could not find a provider who takes bookings there. Please use the search on this page.",
  noSlots: "I could not find a free time in the next week. Please use the search on this page to see other providers.",
  error: "Sorry, something went wrong. Please use the search on this page.",
  held: (time: string, name: string, onlineFee?: number) =>
    `Done. I am holding ${time} with ${name} for 10 minutes. It is not booked yet: tap Sign in and confirm on your screen to finish.${
      onlineFee ? ` After you confirm, you pay ${onlineFee} rupees online on the next screen.` : ""
    } Goodbye.`,
} as const;

function listProviders(results: Provider[]): string {
  const parts = results.slice(0, 3).map((r, i) => `${i + 1}. ${r.name}${r.distance_km !== null ? `, ${r.distance_km} km away` : ""}`);
  return `I found ${results.length} provider${results.length === 1 ? "" : "s"} who take bookings: ${parts.join("; ")}. Which one would you like?`;
}

/** `Friday 2026-11-13` (the session's `today` variable) -> `2026-11-13`. */
export function dateOf(today: string): string {
  return /\d{4}-\d{2}-\d{2}/.exec(today)?.[0] ?? new Date().toISOString().slice(0, 10);
}

export async function runDemoScript(deps: { bookingSession: string; today: string; callTool: ToolCaller; say: Speaker }): Promise<DemoOutcome> {
  const { bookingSession: booking_session, callTool, say } = deps;
  const date_from = dateOf(deps.today);
  const stop = async (line: string, outcome: DemoOutcome): Promise<DemoOutcome> => {
    await say("agent", line);
    return outcome;
  };
  try {
    await say("agent", DEMO_LINES.greeting);
    await say("parent", DEMO_LINES.parentAsk);

    let search = await callTool("search_providers", { booking_session, locality_text: DEMO_AREA, type: "speech_language_pathologist", mode: "in_clinic" });
    let providers = (search.json.results as Provider[] | undefined) ?? [];
    if (search.status === 200 && !providers.length) {
      // Fewer filters, as the agent would offer.
      search = await callTool("search_providers", { booking_session, locality_text: DEMO_AREA });
      providers = (search.json.results as Provider[] | undefined) ?? [];
    }
    if (search.status !== 200) return stop(DEMO_LINES.error, { kind: "error" });
    if (!providers.length) return stop(DEMO_LINES.noProviders, { kind: "no_providers" });

    await say("agent", listProviders(providers));
    await say("parent", DEMO_LINES.parentPickFirst);

    for (const provider of providers.slice(0, 3)) {
      const service_mode = provider.modes.includes("in_clinic") ? "in_clinic" : "video";
      let slots: SlotOffer[] = [];
      for (const part of ["morning", undefined]) {
        const res = await callTool("get_slots", { booking_session, profile_id: provider.profile_id, service_mode, date_from, ...(part ? { part_of_day: part } : {}) });
        if (res.status !== 200) return stop(DEMO_LINES.error, { kind: "error" });
        slots = (res.json.slots as SlotOffer[] | undefined) ?? [];
        if (slots.length) break;
      }
      if (!slots.length) continue;

      await say("agent", `${provider.name} has these times: ${slots.slice(0, 3).map((s) => s.local_time).join("; ")}. Which one should I hold?`);
      await say("parent", DEMO_LINES.parentPickTime);
      const hold = await callTool("hold_slot", { booking_session, profile_id: provider.profile_id, service_id: slots[0].service_id, start: slots[0].start });
      if (hold.status !== 200 || hold.json.held !== true) return stop(DEMO_LINES.error, { kind: "error" });
      const onlineFee = hold.json.payment_mode === "online" ? Number(hold.json.fee_inr) || undefined : undefined;
      await say("agent", DEMO_LINES.held(slots[0].local_time, provider.name, onlineFee));
      return { kind: "held", appointment_id: String(hold.json.appointment_id), profile_id: provider.profile_id };
    }
    return stop(DEMO_LINES.noSlots, { kind: "no_slots" });
  } catch {
    return stop(DEMO_LINES.error, { kind: "error" });
  }
}
