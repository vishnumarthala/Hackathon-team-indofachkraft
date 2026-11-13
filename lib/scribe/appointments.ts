// Ticket 038 FR-3: appointment checks for the AI scribe. Server only.
//
// Appointments belong to 030 (booking) and 035 (appointment-scoped recordings), built in parallel with this ticket.
// This module reads them without depending on their exact columns: the table may not exist yet (then no appointment
// can be chosen) and each row is read as JSON. The scribe is for in-clinic recordings only (decision D-1): a video
// (Google Meet) appointment is refused with 422 `IN_CLINIC_ONLY`.
import type { Queryable } from "@/lib/pg";
import { isUuid } from "@/lib/cases/validation";
import { IN_CLINIC_ONLY } from "./templates";

export type AppointmentMode = "in_clinic" | "video" | "unknown";

export type ScribeAppointment = {
  id: string;
  org_id: string | null;
  case_id: string | null;
  child_id: string | null;
  starts_at: string | null;
  status: string | null;
  mode: AppointmentMode;
};

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Mode of an appointment row (030: `service_snapshot.mode`, or a `mode` column; a Meet link means video). */
export function appointmentMode(row: Json): AppointmentMode {
  const snapshot = (row.service_snapshot ?? null) as Json | null;
  const mode = str(row.mode) ?? str(snapshot?.mode);
  if (mode === "video" || str(row.meet_url)) return "video";
  if (mode === "in_clinic") return "in_clinic";
  return "unknown";
}

/** `slot` is a tstzrange (`["2026-11-20 10:00:00+00","2026-11-20 10:30:00+00")`); its lower bound. */
function slotStart(row: Json): string | null {
  const direct = str(row.starts_at) ?? str(row.start_at);
  if (direct) return direct;
  const slot = str(row.slot);
  const m = slot ? /^[[(]"?([^",]+)"?,/.exec(slot) : null;
  return m ? m[1] : null;
}

export function toScribeAppointment(row: Json): ScribeAppointment {
  return {
    id: String(row.id),
    org_id: str(row.org_id),
    case_id: str(row.case_id),
    child_id: str(row.child_id),
    starts_at: slotStart(row),
    status: str(row.status),
    mode: appointmentMode(row),
  };
}

async function appointmentsTableExists(sql: Queryable): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`select to_regclass('public.appointments') is not null as present`;
  return row?.present === true;
}

/** The appointment, or null (missing id, no appointments table yet). */
export async function findAppointment(sql: Queryable, appointmentId: string): Promise<ScribeAppointment | null> {
  if (!isUuid(appointmentId) || !(await appointmentsTableExists(sql))) return null;
  const rows = await sql<{ row: Json }[]>`select to_jsonb(a) as row from public.appointments a where a.id = ${appointmentId}`;
  return rows[0] ? toScribeAppointment(rows[0].row) : null;
}

/** An appointment may be linked to a recording of a case when it is the same organisation and the same case/child. */
export function appointmentMatchesCase(a: ScribeAppointment, kase: { id: string; org_id: string; child_id: string | null }): boolean {
  if (a.org_id !== kase.org_id) return false;
  return a.case_id === kase.id || (a.child_id !== null && a.child_id === kase.child_id);
}

/** Appointments of the case's child in the case's organisation (newest first) for the upload form's selector. */
export async function listCaseAppointments(
  sql: Queryable,
  kase: { id: string; org_id: string; child_id: string | null },
): Promise<ScribeAppointment[]> {
  if (!(await appointmentsTableExists(sql))) return [];
  const rows = await sql<{ row: Json }[]>`
    select to_jsonb(a) as row from public.appointments a
    where (to_jsonb(a) ->> 'org_id') = ${kase.org_id}
      and ((to_jsonb(a) ->> 'case_id') = ${kase.id} or (to_jsonb(a) ->> 'child_id') = ${kase.child_id ?? ""})
    limit 50`;
  return rows
    .map((r) => toScribeAppointment(r.row))
    .filter((a) => !["held", "expired", "cancelled"].includes(a.status ?? ""))
    .sort((a, b) => (b.starts_at ?? "").localeCompare(a.starts_at ?? ""))
    .slice(0, 20);
}

export type AppointmentCheck = { ok: true; appointment: ScribeAppointment } | { ok: false; status: 404 | 422; error: string };

/** FR-3: the appointment must exist for this case; a video appointment is refused (in-clinic only). */
export async function checkScribeAppointment(
  sql: Queryable,
  appointmentId: string,
  kase: { id: string; org_id: string; child_id: string | null },
): Promise<AppointmentCheck> {
  const appointment = await findAppointment(sql, appointmentId);
  if (!appointment || !appointmentMatchesCase(appointment, kase)) return { ok: false, status: 404, error: "Appointment not found" };
  if (appointment.mode === "video") return { ok: false, status: 422, error: IN_CLINIC_ONLY };
  return { ok: true, appointment };
}
