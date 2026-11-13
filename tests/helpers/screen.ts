// Ticket 033 test helpers: call the check-in route handlers directly (no dev server) and synthetic answer sets.
import { CHECKIN } from "@/lib/clinical/checkin";

let ipSeq = 0;
/** A fresh documentation-range IP per call, so the 5-per-hour limit only applies where a test wants it. */
export const nextIp = () => `198.51.100.${(ipSeq = (ipSeq % 250) + 1)}`;

export const screenReq = (url: string, body?: unknown, ip = nextIp(), method = "POST") =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "x-forwarded-for": ip, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** `fetch` stand-in that dispatches /api/screen/** to the route handlers (what the browser would call). */
export function screenFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const req = new Request(url, init);
    if (url.pathname === "/api/screen/sessions") return (await import("@/app/api/screen/sessions/route")).POST(req);
    const m = url.pathname.match(/^\/api\/screen\/sessions\/([^/]+)(?:\/(answers|red-flag|finish|follow-up|providers))?$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, id, action] = m;
    if (!action) return (await import("@/app/api/screen/sessions/[id]/route")).GET(req, params(id));
    if (action === "answers") return (await import("@/app/api/screen/sessions/[id]/answers/route")).POST(req, params(id));
    if (action === "red-flag") return (await import("@/app/api/screen/sessions/[id]/red-flag/route")).POST(req, params(id));
    // 048: the M-CHAT-R/F Follow-Up and the bookable providers below a result.
    if (action === "follow-up") return (await import("@/app/api/screen/sessions/[id]/follow-up/route")).POST(req, params(id));
    if (action === "providers") return (await import("@/app/api/screen/sessions/[id]/providers/route")).GET(req, params(id));
    return (await import("@/app/api/screen/sessions/[id]/finish/route")).POST(req, params(id));
  }) as typeof fetch;
}

export const ALL_NO_RED_FLAGS = Object.fromEntries(CHECKIN.red_flags.map((r) => [r.id, "no"]));

/** Answer sets with known totals (024 scoring: 0-9 / 10-19 / 20-45). */
export function answerSet(pattern: "no_concerns" | "some_concerns" | "many_concerns"): Record<string, string> {
  const answers: Record<string, string> = { ...ALL_NO_RED_FLAGS };
  for (const q of CHECKIN.questions) {
    if (pattern === "no_concerns") answers[q.id] = q.reverse ? "always" : "never"; // 0
    else if (pattern === "some_concerns") answers[q.id] = q.reverse ? "often" : "sometimes"; // 5*1 + 10*1 = 15
    else answers[q.id] = q.reverse ? "never" : "always"; // 45
  }
  return answers;
}

export const toList = (answers: Record<string, string>) => Object.entries(answers).map(([item_id, answer]) => ({ item_id, answer }));
