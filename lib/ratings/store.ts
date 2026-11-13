// 036 ratings data access. Server-only (shared Postgres pool, lib/pg.ts). Every caller passes its gate first
// (guardian / provider / platform admin); the functions re-check ownership inside one transaction and write their
// audit row there (fail closed, 041). Public reads return published ratings only and never a guardian identity
// (NFR-1); only the admin queue joins the guardian's account.
import { auditFailure, AuditWriteError, auditStrict, type AuditActorRole } from "@/lib/audit";
import { fail } from "@/lib/http";
import { pg, type Queryable } from "@/lib/pg";
import {
  ALREADY_RATED,
  EDIT_CLOSED,
  editCheck,
  NOT_ELIGIBLE,
  PUBLIC_COMMENT_LIMIT,
  RATING_LOCKED,
  rateEligibility,
  statusAfterWrite,
  type RatingStatus,
  type ReviewReason,
} from "./rules";
import { SCREEN_REJECTED, screenComment } from "./screen";
import type { RatingCreate, RatingModerate, RatingUpdate } from "./schemas";

export const RATING_ERRORS = {
  not_eligible: { status: 403, error: NOT_ELIGIBLE },
  already_rated: { status: 409, error: ALREADY_RATED },
  edit_closed: { status: 403, error: EDIT_CLOSED },
  locked: { status: 409, error: RATING_LOCKED },
  screen_rejected: { status: 422, error: SCREEN_REJECTED },
  not_found: { status: 404, error: "Rating not found" },
  already_hidden: { status: 409, error: "This rating is already hidden" },
} as const;
export type RatingErrorCode = keyof typeof RATING_ERRORS;

export class RatingError extends Error {
  constructor(readonly code: RatingErrorCode) {
    super(code);
    this.name = "RatingError";
  }
}

export function ratingErrorResponse(code: RatingErrorCode): Response {
  const { status, error } = RATING_ERRORS[code];
  return fail(status, error);
}

export type Actor = { userId: string; role: AuditActorRole };

export type GuardianRating = {
  id: string;
  appointment_id: string;
  stars: number;
  comment: string | null;
  status: RatingStatus;
  created_at: string;
  edited_at: string | null;
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function toGuardianRating(row: Record<string, unknown>): GuardianRating {
  return {
    id: String(row.id),
    appointment_id: String(row.appointment_id),
    stars: Number(row.stars),
    comment: (row.comment as string | null) ?? null,
    status: row.status as RatingStatus,
    created_at: iso(row.created_at),
    edited_at: isoOrNull(row.edited_at),
  };
}

type AppointmentContext = {
  id: string;
  status: string;
  guardian_user_id: string | null;
  provider_profile_id: string;
  org_id: string;
  child_id: string | null;
  completed_at: Date | null;
};

async function lockAppointment(tx: Queryable, appointmentId: string): Promise<AppointmentContext | null> {
  const [row] = await tx<AppointmentContext[]>`
    select a.id, a.status, a.guardian_user_id, a.provider_profile_id, a.org_id, a.child_id,
           public.appointment_completed_at(a.id) as completed_at
    from public.appointments a where a.id = ${appointmentId} for update`;
  return row ?? null;
}

/** The booked child's name and the guardian's other children (D-3: none of them may appear in a comment). */
async function childNames(tx: Queryable, childId: string | null, guardianId: string): Promise<string[]> {
  const rows = await tx<{ display_name: string }[]>`
    select c.display_name from public.children c where c.id = ${childId}
    union
    select c.display_name from public.guardian_links gl join public.children c on c.id = gl.child_id
    where gl.user_id = ${guardianId} and gl.status = 'active'`;
  return rows.map((r) => r.display_name).filter(Boolean);
}

// ---------- eligibility (pages) ----------

export type RateState =
  | { kind: "eligible" }
  | { kind: "rated"; rating: GuardianRating; editable: boolean }
  | { kind: "not_eligible" };

/** What `userId` may do for this appointment: rate it, see/edit their rating, or nothing. */
export async function rateState(appointmentId: string, userId: string, sql?: Queryable): Promise<RateState> {
  const db = sql ?? (await pg());
  const [a] = await db<AppointmentContext[]>`
    select a.id, a.status, a.guardian_user_id, a.provider_profile_id, a.org_id, a.child_id,
           public.appointment_completed_at(a.id) as completed_at
    from public.appointments a where a.id = ${appointmentId}`;
  if (!a || a.guardian_user_id !== userId) return { kind: "not_eligible" };
  const [r] = await db`select * from public.ratings where appointment_id = ${appointmentId}`;
  if (r) {
    const rating = toGuardianRating(r);
    return { kind: "rated", rating, editable: editCheck({ guardianUserId: String(r.guardian_user_id), createdAt: iso(r.created_at), status: rating.status }, userId) === "ok" };
  }
  const result = rateEligibility({ status: a.status, guardianUserId: a.guardian_user_id, completedAt: a.completed_at }, userId, false);
  return result === "eligible" ? { kind: "eligible" } : { kind: "not_eligible" };
}

/** The guardian's ratings by appointment id (for `/family/appointments`). */
export async function listGuardianRatings(userId: string, appointmentIds: string[]): Promise<Map<string, GuardianRating & { editable: boolean }>> {
  if (!appointmentIds.length) return new Map();
  const sql = await pg();
  const rows = await sql`
    select * from public.ratings where guardian_user_id = ${userId} and appointment_id in ${sql(appointmentIds)}`;
  return new Map(
    rows.map((r) => {
      const rating = toGuardianRating(r);
      return [rating.appointment_id, { ...rating, editable: editCheck({ guardianUserId: userId, createdAt: rating.created_at, status: rating.status }, userId) === "ok" }];
    }),
  );
}

/** Completed appointments of the guardian that can still be rated (no rating yet, within 30 days). */
export async function listRateableAppointmentIds(userId: string, appointmentIds: string[]): Promise<Set<string>> {
  if (!appointmentIds.length) return new Set();
  const sql = await pg();
  const rows = await sql<AppointmentContext[]>`
    select a.id, a.status, a.guardian_user_id, public.appointment_completed_at(a.id) as completed_at
    from public.appointments a
    where a.guardian_user_id = ${userId} and a.status = 'completed' and a.id in ${sql(appointmentIds)}
      and not exists (select 1 from public.ratings r where r.appointment_id = a.id)`;
  return new Set(
    rows
      .filter((a) => rateEligibility({ status: a.status, guardianUserId: a.guardian_user_id, completedAt: a.completed_at }, userId, false) === "eligible")
      .map((a) => a.id),
  );
}

// ---------- guardian writes (FR-2, FR-3, FR-4) ----------

/** POST: one rating per completed appointment of this guardian (D-1). */
export async function createRating(appointmentId: string, actor: Actor, input: RatingCreate): Promise<GuardianRating> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const a = await lockAppointment(tx, appointmentId);
    const [existing] = a ? await tx`select id from public.ratings where appointment_id = ${appointmentId}` : [];
    const eligibility = rateEligibility(
      a ? { status: a.status, guardianUserId: a.guardian_user_id, completedAt: a.completed_at } : null,
      actor.userId,
      Boolean(existing),
    );
    if (eligibility === "not_eligible") throw new RatingError("not_eligible");
    if (eligibility === "already_rated") throw new RatingError("already_rated");
    const screened = screenComment(input.comment, await childNames(tx, a!.child_id, actor.userId));
    if (!screened.ok) throw new RatingError("screen_rejected");
    const next = statusAfterWrite(screened.needsReview);
    const [row] = await tx`
      insert into public.ratings (appointment_id, provider_profile_id, guardian_user_id, stars, comment, status, review_reason)
      values (${appointmentId}, ${a!.provider_profile_id}, ${actor.userId}, ${input.stars}, ${screened.comment}, ${next.status}, ${next.reviewReason})
      on conflict (appointment_id) do nothing
      returning *`;
    if (!row) throw new RatingError("already_rated");
    await auditStrict(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        childId: a!.child_id,
        orgId: a!.org_id,
        action: "rating.created",
        entity: "rating",
        entityId: String(row.id),
        details: { appointment_id: appointmentId, stars: input.stars, has_comment: screened.comment !== null, status: next.status },
      },
      tx,
    );
    return toGuardianRating(row);
  });
}

/** PATCH: the guardian's own rating, within 7 days, unless hidden by an admin. */
export async function updateRating(appointmentId: string, actor: Actor, input: RatingUpdate): Promise<GuardianRating> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const a = await lockAppointment(tx, appointmentId);
    if (!a || a.guardian_user_id !== actor.userId) throw new RatingError("not_eligible");
    const [current] = await tx`select * from public.ratings where appointment_id = ${appointmentId} for update`;
    if (!current) throw new RatingError("not_eligible");
    const check = editCheck({ guardianUserId: String(current.guardian_user_id), createdAt: iso(current.created_at), status: current.status as RatingStatus }, actor.userId);
    if (check === "not_owner") throw new RatingError("not_eligible");
    if (check === "locked") throw new RatingError("locked");
    if (check === "closed") throw new RatingError("edit_closed");
    const comment = input.comment === undefined ? (current.comment as string | null) : input.comment;
    const screened = screenComment(comment, await childNames(tx, a.child_id, actor.userId));
    if (!screened.ok) throw new RatingError("screen_rejected");
    const stars = input.stars ?? Number(current.stars);
    const next = statusAfterWrite(screened.needsReview, { status: current.status as RatingStatus, reviewReason: (current.review_reason as ReviewReason | null) ?? null });
    const [row] = await tx`
      update public.ratings
      set stars = ${stars}, comment = ${screened.comment}, status = ${next.status}, review_reason = ${next.reviewReason ?? current.review_reason ?? null},
          edited_at = now()
      where id = ${current.id}
      returning *`;
    await auditStrict(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        childId: a.child_id,
        orgId: a.org_id,
        action: "rating.updated",
        entity: "rating",
        entityId: String(row.id),
        details: { appointment_id: appointmentId, stars, has_comment: screened.comment !== null, from: current.status, to: next.status },
      },
      tx,
    );
    return toGuardianRating(row);
  });
}

// ---------- public reads (FR-5) ----------

export type PublicSummary = { rating_avg: number | null; rating_count: number };

export async function getRatingSummary(profileId: string, sql?: Queryable): Promise<PublicSummary> {
  const db = sql ?? (await pg());
  const [row] = await db<{ rating_avg: string | null; rating_count: number }[]>`
    select rating_avg, rating_count from public.provider_rating_summary where provider_profile_id = ${profileId}`;
  return { rating_avg: row?.rating_avg === null || row?.rating_avg === undefined ? null : Number(row.rating_avg), rating_count: row?.rating_count ?? 0 };
}

export type PublicComment = { id: string; comment: string; created_at: string };

/** Latest published comments: text and date only (no stars, names or appointment details). */
export async function listPublicComments(profileId: string, limit = PUBLIC_COMMENT_LIMIT, sql?: Queryable): Promise<PublicComment[]> {
  const db = sql ?? (await pg());
  const rows = await db<{ id: string; comment: string; created_at: Date }[]>`
    select id, comment, created_at from public.ratings
    where provider_profile_id = ${profileId} and status = 'published' and comment is not null
    order by created_at desc, id
    limit ${limit}`;
  return rows.map((r) => ({ id: r.id, comment: r.comment, created_at: iso(r.created_at) }));
}

// ---------- provider (FR-6 report) ----------

export type ProviderRating = { id: string; stars: number; comment: string | null; status: RatingStatus; created_at: string; reported: boolean };

/** The provider's own profile: published ratings and the ones they reported (under review). Never the guardian. */
export async function listProviderRatings(profileId: string): Promise<ProviderRating[]> {
  const sql = await pg();
  const rows = await sql`
    select id, stars, comment, status, created_at, (review_reason = 'provider_report' and status = 'pending_review') as reported
    from public.ratings
    where provider_profile_id = ${profileId}
      and (status = 'published' or (status = 'pending_review' and review_reason = 'provider_report'))
    order by created_at desc
    limit 100`;
  return rows.map((r) => ({ id: String(r.id), stars: Number(r.stars), comment: (r.comment as string | null) ?? null, status: r.status as RatingStatus, created_at: iso(r.created_at), reported: Boolean(r.reported) }));
}

/** A provider (profile owner, or owner/admin of the appointment's org) reports a rating -> `pending_review`. */
export async function reportRating(ratingId: string, actor: Actor, reason: string): Promise<{ id: string; status: RatingStatus; changed: boolean }> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [r] = await tx<{ id: string; status: RatingStatus; org_id: string; child_id: string | null; is_provider: boolean }[]>`
      select r.id, r.status, a.org_id, a.child_id, public.booking_is_provider(r.provider_profile_id, a.org_id, ${actor.userId}::uuid) as is_provider
      from public.ratings r join public.appointments a on a.id = r.appointment_id
      where r.id = ${ratingId}
      for update of r`;
    if (!r || !r.is_provider) throw new RatingError("not_found");
    if (r.status === "hidden") throw new RatingError("already_hidden");
    if (r.status === "pending_review") return { id: r.id, status: r.status, changed: false };
    await tx`
      update public.ratings
      set status = 'pending_review', review_reason = 'provider_report', reported_by = ${actor.userId}, reported_at = now(), report_reason = ${reason}
      where id = ${ratingId}`;
    await auditStrict(
      { actorUserId: actor.userId, actorRole: actor.role, orgId: r.org_id, action: "rating.reported", entity: "rating", entityId: ratingId, details: { from: r.status, to: "pending_review" } },
      tx,
    );
    return { id: r.id, status: "pending_review", changed: true };
  });
}

// ---------- platform admin (FR-6 moderation) ----------

export type AdminRating = {
  id: string;
  stars: number;
  comment: string | null;
  status: RatingStatus;
  review_reason: ReviewReason | null;
  report_reason: string | null;
  reported_at: string | null;
  created_at: string;
  edited_at: string | null;
  moderated_at: string | null;
  moderation_note: string | null;
  provider_name: string;
  provider_slug: string;
  guardian_name: string | null;
  guardian_email: string | null;
};

/** NFR-1: the guardian's identity is visible here only (platform admins). */
export async function listRatingsForAdmin(status: RatingStatus, limit = 50): Promise<AdminRating[]> {
  const sql = await pg();
  const rows = await sql`
    select r.id, r.stars, r.comment, r.status, r.review_reason, r.report_reason, r.reported_at, r.created_at, r.edited_at,
           r.moderated_at, r.moderation_note, p.display_name as provider_name, p.slug as provider_slug,
           g.display_name as guardian_name, u.email as guardian_email
    from public.ratings r
    join public.provider_profiles p on p.id = r.provider_profile_id
    left join public.user_profiles g on g.id = r.guardian_user_id
    left join auth.users u on u.id = r.guardian_user_id
    where r.status = ${status}
    order by ${status === "pending_review" ? sql`coalesce(r.reported_at, r.created_at)` : sql`r.created_at desc`}, r.id
    limit ${limit}`;
  return rows.map((r) => ({
    id: String(r.id),
    stars: Number(r.stars),
    comment: (r.comment as string | null) ?? null,
    status: r.status as RatingStatus,
    review_reason: (r.review_reason as ReviewReason | null) ?? null,
    report_reason: (r.report_reason as string | null) ?? null,
    reported_at: isoOrNull(r.reported_at),
    created_at: iso(r.created_at),
    edited_at: isoOrNull(r.edited_at),
    moderated_at: isoOrNull(r.moderated_at),
    moderation_note: (r.moderation_note as string | null) ?? null,
    provider_name: String(r.provider_name),
    provider_slug: String(r.provider_slug),
    guardian_name: (r.guardian_name as string | null) ?? null,
    guardian_email: (r.guardian_email as string | null) ?? null,
  }));
}

export async function countPendingRatings(): Promise<number> {
  const sql = await pg();
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.ratings where status = 'pending_review'`;
  return row.n;
}

/** Publish or hide (with a note) any rating; audited in the same transaction. */
export async function moderateRating(ratingId: string, actor: Actor, input: RatingModerate): Promise<{ id: string; status: RatingStatus }> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [r] = await tx<{ id: string; status: RatingStatus; org_id: string; child_id: string | null }[]>`
      select r.id, r.status, a.org_id, a.child_id from public.ratings r join public.appointments a on a.id = r.appointment_id
      where r.id = ${ratingId} for update of r`;
    if (!r) throw new RatingError("not_found");
    const to: RatingStatus = input.action === "publish" ? "published" : "hidden";
    await tx`
      update public.ratings
      set status = ${to}, moderated_by = ${actor.userId}, moderated_at = now(), moderation_note = ${input.note || null}
      where id = ${ratingId}`;
    await auditStrict(
      {
        actorUserId: actor.userId,
        actorRole: actor.role,
        orgId: r.org_id,
        action: "rating.moderated",
        entity: "rating",
        entityId: ratingId,
        details: { from: r.status, to, has_note: Boolean(input.note) },
      },
      tx,
    );
    return { id: r.id, status: to };
  });
}

/** Runs `fn`; a RatingError becomes its JSON response, a failed audit write 503 (nothing saved). */
export async function withRatingErrors<T>(fn: () => Promise<T>): Promise<{ data: T } | { response: Response }> {
  try {
    return { data: await fn() };
  } catch (err) {
    if (err instanceof RatingError) return { response: ratingErrorResponse(err.code) };
    if (err instanceof AuditWriteError) return { response: auditFailure(err) };
    throw err;
  }
}
