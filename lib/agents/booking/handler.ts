// Ticket 034 FR-3 / NFR-2: one pipeline for every agent tool call. Order: shared secret (live) or the browser's session
// cookie (DEMO_MODE script) -> per-IP burst limit -> JSON body -> per-conversation `booking_session` (valid, unexpired,
// not ended; charged one call, max 20) -> strict schema (unknown keys 400) -> the tool. Nothing from the payload is
// logged or stored; the log line has the tool, status and duration only (NFR-1).
import { NextResponse } from "next/server";
import { AuditWriteError, auditFailure } from "@/lib/audit";
import { fail, fieldErrors } from "@/lib/http";
import { logger } from "@/lib/log";
import type { AgentTool } from "./constants";
import { rateKey, toolBurstLimiter } from "./rate-limit";
import { TOOL_SCHEMAS, type GetSlotsInput, type HoldSlotInput, type SearchProvidersInput } from "./schemas";
import { chargeToolCall, cookieAgentToken, hashAgentToken, verifyAgentSecret } from "./session";
import { getSlotsTool, holdSlotTool, searchProvidersTool, type ToolResult } from "./tools";

const log = logger("booking-agent");

export const INVALID_SESSION = "Invalid or expired booking session";
export const TOO_MANY_CALLS = "Too many tool calls in this booking session";

export type ToolAuth = "secret" | "cookie";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dispatch(tool: AgentTool, data: unknown, ctx: Parameters<typeof holdSlotTool>[1]): Promise<ToolResult> {
  switch (tool) {
    case "search_providers":
      return searchProvidersTool(data as SearchProvidersInput);
    case "get_slots":
      return getSlotsTool(data as GetSlotsInput);
    case "hold_slot":
      return holdSlotTool(data as HoldSlotInput, ctx);
  }
}

export async function handleToolCall(req: Request, tool: AgentTool, auth: ToolAuth): Promise<Response> {
  const started = performance.now();
  const done = (res: Response) => {
    log.info("tool call", { tool, auth, status: res.status, ms: Math.round(performance.now() - started) });
    return res;
  };

  if (auth === "secret" && !verifyAgentSecret(req)) return done(fail(401, "Unauthorized"));
  if (!toolBurstLimiter.allow(rateKey(req))) {
    return done(NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { "Retry-After": "60" } }));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return done(fail(400, "Invalid request", { body: "Body must be JSON" }));
  }
  if (!isPlainObject(body)) return done(fail(400, "Invalid request", { body: "Body must be a JSON object" }));

  const token = typeof body.booking_session === "string" ? body.booking_session : "";
  // DEMO_MODE script: the browser proves the session with its httpOnly cookie instead of the agent secret.
  if (auth === "cookie" && (await cookieAgentToken()) !== token) return done(fail(401, INVALID_SESSION));
  const gate = await chargeToolCall(token);
  if (!gate.ok) return done(gate.status === 429 ? fail(429, TOO_MANY_CALLS) : fail(401, INVALID_SESSION));

  const parsed = TOOL_SCHEMAS[tool].safeParse(body);
  if (!parsed.success) return done(fail(400, "Invalid request", fieldErrors(parsed.error)));

  try {
    const result = await dispatch(tool, parsed.data, { session: gate.session, tokenHash: hashAgentToken(token) });
    return done(NextResponse.json(result.body, { status: result.status }));
  } catch (err) {
    if (err instanceof AuditWriteError) return done(auditFailure(err));
    throw err;
  }
}
