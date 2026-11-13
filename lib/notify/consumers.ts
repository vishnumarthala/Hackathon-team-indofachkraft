// Outbox consumers (ticket 035): domain work that runs when an event is fanned out, in the fan-out transaction and
// before recipients/templates. A consumer may return an enriched payload (ids and small non-clinical values only);
// the worker stores it on the event, so email/WhatsApp deliveries render the same text later. A throwing consumer
// rolls back the event's savepoint: the event stays pending and is retried on the next run, so consumers must be
// idempotent. Topics that only have consumers (no notifications) are listed in CONSUMER_TOPICS.
import { z } from "zod";
import { issueIntakeLinksForChild, prepareAppointmentIntake } from "@/lib/booking/case-link";
import type { Queryable } from "@/lib/pg";
import type { OutboxEventRow } from "./types";

export type ConsumerContext = { sql: Queryable; event: OutboxEventRow };
export type Consumer = {
  name: string;
  run(payload: Record<string, unknown>, ctx: ConsumerContext): Promise<Record<string, unknown> | void>;
};

const appointmentRef = z.object({ appointment_id: z.uuid() }).passthrough();

// 035 FR-2/FR-3: confirmed (or moved) appointment -> org case + provider assignment + intake attempt. The confirmation
// then says either "take the call: <link>" or "allow the AI intake call" (payload `intake`).
const linkCase: Consumer = {
  name: "appointment.link_case",
  async run(payload, { sql }) {
    const parsed = appointmentRef.safeParse(payload);
    if (!parsed.success) return;
    const notice = await prepareAppointmentIntake(sql, parsed.data.appointment_id);
    if (!notice && !("intake" in payload)) return;
    const next = { ...payload };
    delete next.intake;
    return notice ? { ...next, intake: notice } : next;
  },
};

// 035 FR-3: consent granted later -> links for the child's upcoming appointments (`appointment.intake_link`).
const intakeOnConsent: Consumer = {
  name: "appointment.intake_on_consent",
  async run(payload, { sql }) {
    const parsed = z.object({ child_id: z.uuid(), feature: z.literal("ai_intake_call") }).safeParse(payload);
    if (!parsed.success) return;
    await issueIntakeLinksForChild(sql, parsed.data.child_id);
  },
};

export const CONSUMERS: Record<string, Consumer[]> = {
  "appointment.confirmed": [linkCase],
  "appointment.rescheduled": [linkCase],
  "consent.granted": [intakeOnConsent],
};

/** Consumer-only topics (enqueued by SQL triggers; no notification template). */
export const CONSUMER_TOPICS = ["consent.granted"] as const;

/** Runs the topic's consumers; returns the event with its (possibly enriched, already stored) payload. */
export async function runConsumers(sql: Queryable, event: OutboxEventRow): Promise<{ event: OutboxEventRow; ran: boolean }> {
  const consumers = CONSUMERS[event.topic];
  if (!consumers?.length) return { event, ran: false };
  let payload = event.payload;
  for (const consumer of consumers) {
    const next = await consumer.run(payload, { sql, event });
    if (next) payload = next;
  }
  if (payload !== event.payload) {
    await sql`update public.outbox_events set payload = ${sql.json(payload as never)} where id = ${event.id}`;
  }
  return { event: { ...event, payload }, ran: true };
}
