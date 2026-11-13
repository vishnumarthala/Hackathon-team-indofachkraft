// Ticket 034 FR-3: the agent's server tools. Server-only. Each handler gets validated input (lib/agents/booking/
// schemas.ts) and an authenticated, charged session (lib/agents/booking/handler.ts). They reuse the directory (029)
// and booking (030) code: the agent can search, read free times and place a 10-minute hold owned by the parent's
// browser. There is deliberately no confirm tool: only a signed-in guardian confirms, on screen (D-2).
import { randomUUID } from "node:crypto";
import { auditStrict } from "@/lib/audit";
import { toBookingError, type BookingErrorCode, BOOKING_ERRORS } from "@/lib/booking/errors";
import { checkHoldPreconditions } from "@/lib/booking/hooks";
import { getBookableProfile, getService, getSlots, holdSlot, listServices } from "@/lib/booking/store";
import { utcToWall } from "@/lib/booking/time";
import { DEFAULT_RADIUS_KM, isInIndia, SEO_RADIUS_KM } from "@/lib/geo/constants";
import { getGeocoder } from "@/lib/geo/geocode";
import { searchProviders } from "@/lib/geo/search";
import { pg } from "@/lib/pg";
import { confirmUrl, MAX_PROVIDERS, MAX_SLOTS, partOfDayOf, SLOT_SEARCH_DAYS } from "./constants";
import type { GetSlotsInput, HoldSlotInput, SearchProvidersInput } from "./schemas";
import { setSessionHold, type AgentSession } from "./session";

export type ToolResult = { status: number; body: Record<string, unknown> };

export type ToolContext = { session: AgentSession; tokenHash: string };

const ok = (body: Record<string, unknown>): ToolResult => ({ status: 200, body });
const notFound = (error: string, message: string): ToolResult => ({ status: 404, body: { error, message } });

/** A spoken-friendly local time, e.g. `Saturday 14 November, 10:30 am`. */
export function spokenTime(start: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  })
    .format(new Date(start))
    .replace(" at ", ", ");
}

// ---------- search_providers ----------

export type ProviderResult = {
  profile_id: string;
  name: string;
  type: string;
  locality: string | null;
  distance_km: number | null;
  modes: ("in_clinic" | "video")[];
  languages: string[];
};

async function bookableProfileIds(ids: string[], mode: "in_clinic" | "video" | "any"): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const sql = await pg();
  const rows = await sql<{ id: string }[]>`
    select distinct provider_profile_id as id from public.services
    where active and provider_profile_id in ${sql(ids)} ${mode === "any" ? sql`` : sql`and mode = ${mode}`}`;
  return new Set(rows.map((r) => r.id));
}

export async function searchProvidersTool(input: SearchProvidersInput): Promise<ToolResult> {
  const hit = await getGeocoder().geocodeQuery(input.locality_text);
  if (!hit || !isInIndia(hit.lat, hit.lng)) {
    return ok({ results: [], message: "I could not find that place. Ask the parent for a locality or PIN code in Hyderabad." });
  }
  const mode = input.mode ?? "any";
  let results: ProviderResult[] = [];
  // Nearby first; widen once when nothing bookable is close.
  for (const radiusKm of [DEFAULT_RADIUS_KM, SEO_RADIUS_KM]) {
    const page = await searchProviders({ lat: hit.lat, lng: hit.lng, radiusKm, type: input.type, language: input.language, mode, page: 1, pageSize: 25 });
    const bookable = await bookableProfileIds(page.results.map((r) => r.profile_id), mode);
    results = page.results
      .filter((r) => bookable.has(r.profile_id))
      .slice(0, MAX_PROVIDERS)
      .map((r) => ({
        profile_id: r.profile_id,
        name: r.display_name,
        type: r.provider_type,
        locality: r.locality,
        distance_km: r.distance_km === null ? null : Math.round(r.distance_km * 10) / 10,
        modes: [...(r.offers_in_clinic ? (["in_clinic"] as const) : []), ...(r.offers_video ? (["video"] as const) : [])],
        languages: r.languages,
      }));
    if (results.length) break;
  }
  const place = hit.locality ?? input.locality_text;
  return ok({
    place,
    results,
    message: results.length
      ? `Found ${results.length} provider(s) near ${place} who take bookings. Read out the names, then ask which one and whether the parent wants in-clinic or video.`
      : `No bookable providers found near ${place} for these filters. Offer to try another area or fewer filters.`,
  });
}

// ---------- get_slots ----------

export type SlotResult = {
  service_id: string;
  service_name: string;
  start: string;
  end: string;
  local_time: string;
  time_zone: string;
  /** 031: `online` = the parent pays this fee online after confirming on screen. */
  payment_mode: "online" | "at_clinic" | "free";
  fee_inr: number;
};

export async function getSlotsTool(input: GetSlotsInput): Promise<ToolResult> {
  const profile = await getBookableProfile(input.profile_id);
  if (!profile) return notFound("Provider not found", "This provider cannot be booked. Search again.");
  const services = (await listServices(profile.id, { activeOnly: true })).filter((s) => s.mode === input.service_mode);
  const label = input.service_mode === "video" ? "video" : "in-clinic";
  if (!services.length) {
    return ok({ provider_name: profile.display_name, slots: [], message: `${profile.display_name} has no ${label} appointments. Offer the other mode or another provider.` });
  }
  const all: SlotResult[] = [];
  for (const service of services) {
    const { slots } = await getSlots(service, { from: input.date_from, days: SLOT_SEARCH_DAYS });
    for (const slot of slots) {
      if (input.part_of_day && partOfDayOf(utcToWall(Date.parse(slot.start), service.time_zone).minutes) !== input.part_of_day) continue;
      all.push({
        service_id: service.id,
        service_name: service.name,
        start: slot.start,
        end: slot.end,
        local_time: spokenTime(slot.start, service.time_zone),
        time_zone: service.time_zone,
        payment_mode: service.payment_mode,
        fee_inr: service.fee_inr,
      });
    }
  }
  all.sort((a, b) => a.start.localeCompare(b.start) || a.service_name.localeCompare(b.service_name));
  const slots = all.slice(0, MAX_SLOTS);
  return ok({
    provider_name: profile.display_name,
    slots,
    message: slots.length
      ? `Offer these ${label} times (local_time) and ask which one to hold. Mention the fee (fee_inr, in rupees; payment_mode online = paid online after confirming, at_clinic = paid at the clinic, free = no fee). Use the exact service_id and start in hold_slot.`
      : `No free ${label} times in the ${SLOT_SEARCH_DAYS} days from ${input.date_from}${input.part_of_day ? ` in the ${input.part_of_day}` : ""}. Offer another day or part of the day.`,
  });
}

// ---------- hold_slot ----------

/** Booking refusals the agent can talk the parent through (anything else is a server error). */
const HOLD_REFUSALS: BookingErrorCode[] = ["slot_taken", "slot_unavailable", "too_soon", "too_far"];

export const HOLD_CREATED_ACTION = "booking_agent.hold_created";

export async function holdSlotTool(input: HoldSlotInput, ctx: ToolContext): Promise<ToolResult> {
  const service = await getService(input.service_id);
  const profile = service?.active && service.provider_profile_id === input.profile_id ? await getBookableProfile(service.provider_profile_id) : null;
  if (!service || !profile) return notFound("Service not found", "This time cannot be booked. Read the free times again with get_slots.");

  const blocked = await checkHoldPreconditions({ profile, service, userId: null, body: { service_id: input.service_id, start: input.start } });
  if (blocked) return ok({ held: false, reason: blocked.code, message: `${blocked.error} The parent can book on the provider's page instead.` });

  const sql = await pg();
  try {
    const held = await sql.begin(async (tx) => {
      // A random key per call: a retry places a fresh hold and the SQL releases the older one (one hold per owner).
      const result = await holdSlot({ service_id: service.id, start: input.start, idempotency_key: `agent:${randomUUID()}` }, { sessionHash: ctx.session.owner_session_hash }, tx);
      await setSessionHold(ctx.session.id, result.appointment_id, tx);
      // FR-5: actor `ai`; the details carry only the agent session's hash (no payload, no transcript).
      await auditStrict(
        {
          actor: "ai",
          actorRole: "ai",
          orgId: service.org_id,
          action: HOLD_CREATED_ACTION,
          entity: "appointment",
          entityId: result.appointment_id,
          details: { session_hash: ctx.tokenHash },
        },
        tx,
      );
      return result;
    });
    const start = new Date(input.start).toISOString();
    // 031: online services move to pending_payment at confirm and the 030 page continues to the payment step.
    const payNext =
      service.payment_mode === "online" && service.fee_inr > 0
        ? ` After confirming, the parent pays the fee of ${service.fee_inr} rupees online on the next screen to complete the booking.`
        : "";
    return ok({
      held: true,
      appointment_id: held.appointment_id,
      expires_at: held.hold_expires_at,
      confirm_url: confirmUrl(profile.id, held.appointment_id),
      provider_name: profile.display_name,
      start,
      local_time: spokenTime(start, service.time_zone),
      payment_mode: service.payment_mode,
      fee_inr: service.fee_inr,
      message: `The time is held for 10 minutes, not booked yet. Tell the parent to tap 'Sign in and confirm' on their screen to finish.${payNext} You cannot confirm the booking yourself.`,
    });
  } catch (err) {
    const known = toBookingError(err);
    if (known && HOLD_REFUSALS.includes(known.code)) {
      return ok({
        held: false,
        reason: known.code,
        message: known.code === "slot_taken" ? "Someone just took this time. Read the free times again and offer another one." : BOOKING_ERRORS[known.code].error,
      });
    }
    if (known) return { status: BOOKING_ERRORS[known.code].status, body: { error: BOOKING_ERRORS[known.code].error, code: known.code } };
    throw err;
  }
}
