// Request schemas for the booking APIs (FR-4, FR-8). Unknown keys are stripped; ids come from the session, never
// from the body (owner, guardian, provider are resolved server-side).
import { z } from "zod";
import { isValidDate } from "./time";

const uuid = z.uuid();
const TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const timeField = z.string().regex(TIME, "Use HH:MM");
const dateField = z.string().refine(isValidDate, "Use YYYY-MM-DD");
const isoInstant = z.iso.datetime({ offset: true });

export const SERVICE_MODES = ["in_clinic", "video"] as const;
export const RULE_MODES = ["in_clinic", "video", "both"] as const;
export const DURATIONS = [15, 20, 30, 45, 60, 90] as const;
export const PAYMENT_MODES = ["online", "at_clinic", "free"] as const;
export const INTAKE_KINDS = ["child_dev", "generic", "none"] as const;
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export const SlotsQuerySchema = z.object({
  service_id: uuid,
  from: dateField.optional(),
  days: z.coerce.number().int().min(1).max(14).default(7),
});

export const HoldSchema = z.object({
  service_id: uuid,
  start: isoInstant,
  idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/, "8-200 letters, digits, _ . : -"),
  /** 042 FR-2a: required (true) for demo profiles, checked in lib/booking/hooks.ts. */
  demo_ack: z.boolean().optional(),
});

export const ConfirmSchema = z.object({ child_id: uuid });
export const CancelSchema = z.object({ reason: z.string().trim().max(300).optional() });
export const RescheduleSchema = z.object({ start: isoInstant });
export const CompleteSchema = z.object({ status: z.enum(["completed", "no_show"]) });

const serviceFields = {
  name: z.string().trim().min(1).max(80),
  duration_min: z
    .number()
    .int()
    .refine((d) => (DURATIONS as readonly number[]).includes(d), "Choose 15, 20, 30, 45, 60 or 90 minutes"),
  fee_inr: z.number().int().min(0).max(100000),
  payment_mode: z.enum(PAYMENT_MODES),
  buffer_min: z.number().int().min(0).max(30),
  intake_kind: z.enum(INTAKE_KINDS),
};

export const ServiceCreateSchema = z
  .object({
    ...serviceFields,
    mode: z.enum(SERVICE_MODES),
    location_id: uuid.optional(),
    org_id: uuid.optional(),
    buffer_min: serviceFields.buffer_min.default(0),
    // 035 D-4: omitted -> the provider type's default (lib/booking/intake-defaults.ts), applied in createService.
    intake_kind: serviceFields.intake_kind.optional(),
  })
  .refine((s) => s.mode !== "in_clinic" || s.location_id, { path: ["location_id"], message: "Choose a location" })
  .refine((s) => s.payment_mode !== "free" || s.fee_inr === 0, { path: ["fee_inr"], message: "A free service has no fee" });

export const ServiceUpdateSchema = z
  .object({ ...serviceFields, active: z.boolean() })
  .partial()
  .refine((s) => Object.keys(s).length > 0, { message: "Nothing to update" });

export const RuleCreateSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start_time: timeField,
    end_time: timeField,
    mode: z.enum(RULE_MODES),
    location_id: uuid.optional(),
    org_id: uuid.optional(),
    valid_from: dateField.optional(),
    valid_to: dateField.optional(),
  })
  .refine((r) => r.start_time < r.end_time, { path: ["end_time"], message: "End after start" })
  .refine((r) => r.mode === "video" || r.location_id, { path: ["location_id"], message: "Choose a location" })
  .refine((r) => !r.valid_to || !r.valid_from || r.valid_to >= r.valid_from, { path: ["valid_to"], message: "End after start" });

export const OverrideCreateSchema = z
  .object({
    date: dateField,
    kind: z.enum(["unavailable", "extra"]),
    start_time: timeField.optional(),
    end_time: timeField.optional(),
    mode: z.enum(RULE_MODES).optional(),
    location_id: uuid.optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine((o) => Boolean(o.start_time) === Boolean(o.end_time), { path: ["end_time"], message: "Give both times" })
  .refine((o) => !o.start_time || !o.end_time || o.start_time < o.end_time, { path: ["end_time"], message: "End after start" })
  .refine((o) => o.kind === "unavailable" || (o.start_time && o.mode), { path: ["start_time"], message: "Give the hours" })
  .refine((o) => o.kind === "unavailable" || o.mode === "video" || o.location_id, { path: ["location_id"], message: "Choose a location" });

export type HoldInput = z.output<typeof HoldSchema>;
export type ServiceCreate = z.output<typeof ServiceCreateSchema>;
export type ServiceUpdate = z.output<typeof ServiceUpdateSchema>;
export type RuleCreate = z.output<typeof RuleCreateSchema>;
export type OverrideCreate = z.output<typeof OverrideCreateSchema>;
