// Ticket 034 NFR-3: the DEMO_MODE scripted conversation. Runs in the browser and calls the same tool handlers as the
// real agent (through /api/agents/booking/demo/<tool>, cookie-bound). Pure apart from the injected `callTool` / `say`,
// so tests drive it directly. No names or contact details anywhere in the script.
// 049: the script speaks the call language. The server sends the lines and the spoken-word lexicon of that language
// (`demo_script`, from messages/{en,hi,te}.json); the parent's scripted words are turned into tool arguments by the
// lexicon (lib/agents/lexicon.ts) the way the live agent maps them, so a Telugu or Hindi conversation makes exactly the
// same tool calls as the English one (FR-3 / FR-6). Without a script the English one below is used.
import type { Locale } from "@/lib/i18n/config";
import { fillTemplate } from "../languages";
import { interpretBookingRequest, interpretChoice, isYes, type Lexicon } from "../lexicon";
import type { AgentTool } from "./constants";

export type ToolCaller = (tool: AgentTool, args: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
export type Speaker = (role: "agent" | "parent", text: string) => Promise<void> | void;

type Provider = { profile_id: string; name: string; locality: string | null; distance_km: number | null; modes: string[] };
type SlotOffer = { service_id: string; start: string; local_time: string };

export type DemoOutcome =
  | { kind: "held"; appointment_id: string; profile_id: string }
  | { kind: "no_providers" }
  | { kind: "no_slots" }
  | { kind: "refused" }
  | { kind: "error" };

/** Templates (`{name}` placeholders) of `voiceAgents.booking.demo` plus the first message. */
export type BookingDemoLines = {
  greeting: string;
  parentAsk: string;
  parentPickFirst: string;
  parentPickTime: string;
  parentDemoAck: string;
  providers: string;
  providerItem: string;
  times: string;
  noProviders: string;
  noSlots: string;
  error: string;
  demoNotice: string;
  googleRequired: string;
  held: string;
  heldOnline: string;
};

export type BookingLexicon = Pick<Lexicon, "answers" | "types" | "modes" | "partsOfDay" | "choices" | "localities">;

export type BookingDemoScript = {
  language: Locale;
  /** The demo area as the parent says it in this language (e.g. బంజారా హిల్స్). */
  area: string;
  lines: BookingDemoLines;
  lexicon: BookingLexicon;
};

export const DEMO_AREA = "Banjara Hills";

/** The English script (equal to messages/en.json `voiceAgents.booking` / `voiceAgents.lexicon`, tested). */
export const EN_BOOKING_DEMO: BookingDemoScript = {
  language: "en",
  area: DEMO_AREA,
  lines: {
    greeting:
      "Hello, I am DoctorNearMe's booking assistant. I am an AI. I can find a provider near you and hold a time for 10 minutes; you then sign in and confirm on your screen. Please do not tell me your child's name or any contact details. Which area are you in, and what kind of specialist do you need?",
    parentAsk: "A speech therapist near {area}, at the clinic, for my child aged 3 to 5.",
    parentPickFirst: "The first one, please. Any morning this week.",
    parentPickTime: "The first time, please.",
    parentDemoAck: "Yes, I understand this is a demo.",
    providers: "I found these providers who take bookings: {list}. Which one would you like?",
    providerItem: "{n}. {name}, {distance} km away",
    times: "{name} has these times: {times}. Which one should I hold?",
    noProviders: "I could not find a provider who takes bookings there. Please use the search on this page.",
    noSlots: "I could not find a free time in the next week. Please use the search on this page to see other providers.",
    error: "Sorry, something went wrong. Please use the search on this page.",
    demoNotice: "This is a demo profile. No real consultation will take place. Do you understand this is a demo?",
    googleRequired:
      "Video consultations need your Google account, so I cannot hold this time. Please tap the provider in the search on this page, sign in with Google and book there.",
    held: "Done. I am holding {time} with {name} for 10 minutes. It is not booked yet: tap Sign in and confirm on your screen to finish. Goodbye.",
    heldOnline:
      "Done. I am holding {time} with {name} for 10 minutes. It is not booked yet: tap Sign in and confirm on your screen to finish. After you confirm, you pay {fee} rupees online on the next screen. Goodbye.",
  },
  lexicon: {
    answers: {
      never: "never, not at all",
      sometimes: "sometimes, now and then",
      often: "often, a lot, usually, most of the time",
      always: "always, all the time",
      yes: "yes, yeah",
      no: "no, not really, nope",
    },
    types: {
      speech_language_pathologist: "speech therapist, speech-language pathologist",
      occupational_therapist: "occupational therapist",
      child_psychologist: "child psychologist",
      developmental_pediatrician: "developmental pediatrician, developmental paediatrician",
    },
    modes: { in_clinic: "at the clinic, in clinic, in person", video: "video, online" },
    partsOfDay: { morning: "morning", afternoon: "afternoon", evening: "evening" },
    choices: { first: "first, 1st", second: "second, 2nd", third: "third, 3rd" },
    localities: { banjaraHills: "Banjara Hills", kukatpally: "Kukatpally", gachibowli: "Gachibowli", madhapur: "Madhapur" },
  },
};

const en = EN_BOOKING_DEMO.lines;

/** The English lines (034's names, kept for callers and tests). */
export const DEMO_LINES = {
  greeting: en.greeting,
  parentAsk: fillTemplate(en.parentAsk, { area: DEMO_AREA }),
  parentPickFirst: en.parentPickFirst,
  parentPickTime: en.parentPickTime,
  noProviders: en.noProviders,
  noSlots: en.noSlots,
  error: en.error,
  demoNotice: en.demoNotice,
  parentDemoAck: en.parentDemoAck,
  googleRequired: en.googleRequired,
  held: (time: string, name: string, onlineFee?: number) =>
    onlineFee ? fillTemplate(en.heldOnline, { time, name, fee: onlineFee }) : fillTemplate(en.held, { time, name }),
} as const;

function listProviders(lines: BookingDemoLines, results: Provider[]): string {
  const list = results
    .slice(0, 3)
    .map((r, i) => (r.distance_km !== null ? fillTemplate(lines.providerItem, { n: i + 1, name: r.name, distance: r.distance_km }) : `${i + 1}. ${r.name}`))
    .join("; ");
  return fillTemplate(lines.providers, { list });
}

/** `Friday 2026-11-13` (the session's `today` variable) -> `2026-11-13`. */
export function dateOf(today: string): string {
  return /\d{4}-\d{2}-\d{2}/.exec(today)?.[0] ?? new Date().toISOString().slice(0, 10);
}

export async function runDemoScript(deps: {
  bookingSession: string;
  today: string;
  callTool: ToolCaller;
  say: Speaker;
  /** 049: the call language's lines and lexicon (default English). */
  script?: BookingDemoScript;
}): Promise<DemoOutcome> {
  const { bookingSession: booking_session, callTool, say } = deps;
  const { lines, lexicon, area } = deps.script ?? EN_BOOKING_DEMO;
  const x = lexicon as Lexicon;
  const date_from = dateOf(deps.today);
  const stop = async (line: string, outcome: DemoOutcome): Promise<DemoOutcome> => {
    await say("agent", line);
    return outcome;
  };
  try {
    await say("agent", lines.greeting);
    const ask = fillTemplate(lines.parentAsk, { area });
    await say("parent", ask);

    // The agent's part: the parent's words -> codes and the English place name (FR-3).
    const wanted = interpretBookingRequest(x, ask);
    const searchArgs = {
      booking_session,
      locality_text: wanted.locality_text ?? area,
      ...(wanted.type ? { type: wanted.type } : {}),
      ...(wanted.mode ? { mode: wanted.mode } : {}),
    };
    let search = await callTool("search_providers", searchArgs);
    let providers = (search.json.results as Provider[] | undefined) ?? [];
    if (search.status === 200 && !providers.length) {
      // Fewer filters, as the agent would offer.
      search = await callTool("search_providers", { booking_session, locality_text: searchArgs.locality_text });
      providers = (search.json.results as Provider[] | undefined) ?? [];
    }
    if (search.status !== 200) return stop(lines.error, { kind: "error" });
    if (!providers.length) return stop(lines.noProviders, { kind: "no_providers" });

    await say("agent", listProviders(lines, providers));
    await say("parent", lines.parentPickFirst);
    const offered = providers.slice(0, 3);
    const chosen = Math.min(interpretChoice(x, lines.parentPickFirst) ?? 0, offered.length - 1);
    const part = interpretBookingRequest(x, lines.parentPickFirst).part_of_day;

    for (const provider of [...offered.slice(chosen), ...offered.slice(0, chosen)]) {
      const service_mode = provider.modes.includes("in_clinic") ? "in_clinic" : "video";
      let slots: SlotOffer[] = [];
      for (const part_of_day of [part, undefined]) {
        const res = await callTool("get_slots", { booking_session, profile_id: provider.profile_id, service_mode, date_from, ...(part_of_day ? { part_of_day } : {}) });
        if (res.status !== 200) return stop(lines.error, { kind: "error" });
        slots = (res.json.slots as SlotOffer[] | undefined) ?? [];
        if (slots.length || !part_of_day) break;
      }
      if (!slots.length) continue;

      const shown = slots.slice(0, 3);
      await say("agent", fillTemplate(lines.times, { name: provider.name, times: shown.map((s) => s.local_time).join("; ") }));
      await say("parent", lines.parentPickTime);
      const slot = shown[Math.min(interpretChoice(x, lines.parentPickTime) ?? 0, shown.length - 1)];
      const holdArgs = { booking_session, profile_id: provider.profile_id, service_id: slot.service_id, start: slot.start };
      let hold = await callTool("hold_slot", holdArgs);
      // 042 FR-2a: demo profiles need the parent's spoken acknowledgement before the hold.
      if (hold.status === 200 && hold.json.reason === "demo_ack_required") {
        await say("agent", lines.demoNotice);
        await say("parent", lines.parentDemoAck);
        if (!isYes(x, lines.parentDemoAck)) return stop(lines.noSlots, { kind: "refused" });
        hold = await callTool("hold_slot", { ...holdArgs, demo_acknowledged: true });
      }
      if (hold.status === 200 && hold.json.reason === "google_account_required") return stop(lines.googleRequired, { kind: "refused" });
      if (hold.status !== 200 || hold.json.held !== true) return stop(lines.error, { kind: "error" });
      const onlineFee = hold.json.payment_mode === "online" ? Number(hold.json.fee_inr) || undefined : undefined;
      await say(
        "agent",
        onlineFee
          ? fillTemplate(lines.heldOnline, { time: slot.local_time, name: provider.name, fee: onlineFee })
          : fillTemplate(lines.held, { time: slot.local_time, name: provider.name }),
      );
      return { kind: "held", appointment_id: String(hold.json.appointment_id), profile_id: provider.profile_id };
    }
    return stop(lines.noSlots, { kind: "no_slots" });
  } catch {
    return stop(lines.error, { kind: "error" });
  }
}
