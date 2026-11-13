// Ticket 036: verified-booking ratings. Pure rules (eligibility matrix, 30-day window, 7-day edit, comment screening,
// display threshold) and, against the real database through the route handlers: the rate prompt after completion,
// rating / editing / duplicates / negatives, the summary view (published only), search_providers' rating columns,
// provider reports, admin moderation, audit rows and the privacy registry. Synthetic users only; DB part skipped
// without DATABASE_URL.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ratingBadge, monthYear } from "@/lib/ratings/display";
import { editCheck, NOT_ELIGIBLE, rateEligibility, statusAfterWrite } from "@/lib/ratings/rules";
import { contactReason, isAbusive, mentionsName, SCREEN_REJECTED, screenComment } from "@/lib/ratings/screen";
import { purgeTestAudit } from "./helpers/audit";
import { bookingWorld, futureSlot, key, type TestProvider } from "./helpers/booking";
import { ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-13T10:00:00Z");
const GUARDIAN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("eligibility (FR-2, D-1)", () => {
  const completed = (daysAgo: number, status = "completed", guardian: string | null = GUARDIAN) => ({
    status,
    guardianUserId: guardian,
    completedAt: new Date(NOW - daysAgo * DAY),
  });

  it.each([
    ["completed, own, 1 day ago", completed(1), GUARDIAN, false, "eligible"],
    ["completed, own, 29.9 days ago", completed(29.9), GUARDIAN, false, "eligible"],
    ["completed, own, exactly 30 days ago", completed(30), GUARDIAN, false, "eligible"],
    ["completed, own, 30 days + 1 minute ago", { ...completed(30), completedAt: new Date(NOW - 30 * DAY - 60_000) }, GUARDIAN, false, "not_eligible"],
    ["completed, someone else's", completed(1), OTHER, false, "not_eligible"],
    ["completed, guardian removed", completed(1, "completed", null), GUARDIAN, false, "not_eligible"],
    ["completed, already rated", completed(1), GUARDIAN, true, "already_rated"],
    ["someone else's, already rated (no leak)", completed(1), OTHER, true, "not_eligible"],
    ...["held", "pending_payment", "confirmed", "cancelled", "expired", "no_show"].map(
      (s) => [`${s}`, completed(1, s), GUARDIAN, false, "not_eligible"] as const,
    ),
    ["missing appointment", null, GUARDIAN, false, "not_eligible"],
    ["completed without a completion time", { status: "completed", guardianUserId: GUARDIAN, completedAt: null }, GUARDIAN, false, "not_eligible"],
  ] as const)("%s -> %s", (_label, appointment, user, rated, expected) => {
    expect(rateEligibility(appointment, user, rated, NOW)).toBe(expected);
  });

  it("edits: owner within 7 days; closed after; hidden ratings locked; others not_owner", () => {
    const rating = (daysAgo: number, status: "published" | "hidden" | "pending_review" = "published") => ({
      guardianUserId: GUARDIAN,
      createdAt: new Date(NOW - daysAgo * DAY),
      status,
    });
    expect(editCheck(rating(0), GUARDIAN, NOW)).toBe("ok");
    expect(editCheck(rating(6.9), GUARDIAN, NOW)).toBe("ok");
    expect(editCheck(rating(7.01), GUARDIAN, NOW)).toBe("closed");
    expect(editCheck(rating(1, "pending_review"), GUARDIAN, NOW)).toBe("ok");
    expect(editCheck(rating(1, "hidden"), GUARDIAN, NOW)).toBe("locked");
    expect(editCheck(rating(1), OTHER, NOW)).toBe("not_owner");
  });

  it("status after a write: abuse -> review; a provider report stays in review; clean -> published", () => {
    expect(statusAfterWrite(false)).toEqual({ status: "published", reviewReason: null });
    expect(statusAfterWrite(true)).toEqual({ status: "pending_review", reviewReason: "abuse_screen" });
    expect(statusAfterWrite(false, { status: "pending_review", reviewReason: "abuse_screen" })).toEqual({ status: "published", reviewReason: null });
    expect(statusAfterWrite(false, { status: "pending_review", reviewReason: "provider_report" })).toEqual({ status: "pending_review", reviewReason: "provider_report" });
  });
});

describe("comment screening (FR-4, D-3)", () => {
  const CHILD = ["Aarav Reddy"];

  it.each([
    ["9876543210", "phone"],
    ["call me on +91 98765 43210", "phone"],
    ["098765-43210 any time", "phone"],
    ["(040) 2345 6789", "phone"],
    ["९८७६५४३२१० please", "phone"],
    ["mail parent.synthetic@example.test", "email"],
    ["write to parent [at] example [dot] com", "email"],
    ["insta @aarav_dad", "email"],
    ["see https://example.test/review", "url"],
    ["www.example.com has more", "url"],
    ["drsynthetic.in is the site", "url"],
  ])("rejects contact details: %s", (comment, reason) => {
    expect(contactReason(comment)).toBe(reason);
    expect(screenComment(comment, CHILD)).toEqual({ ok: false, reason });
  });

  it.each(["Aarav loved the session", "my son aarav is happier", "AARAV REDDY", "Reddy family thanks you"])("rejects the child's name: %s", (comment) => {
    expect(screenComment(comment, CHILD)).toEqual({ ok: false, reason: "name" });
  });

  it("matches names in Indic scripts and other linked children, but not ordinary words", () => {
    expect(mentionsName("ఆరవ్ చాలా సంతోషంగా ఉన్నాడు", ["ఆరవ్ రెడ్డి"])).toBe(true);
    expect(mentionsName("आरव को बहुत अच्छा लगा", ["आरव"])).toBe(true);
    expect(screenComment("Meera and her brother enjoyed it", ["Aarav Reddy", "Meera Reddy"])).toEqual({ ok: false, reason: "name" });
    // Generic tokens of synthetic names ("child", "synthetic") never count as a name.
    expect(screenComment("My child liked the synthetic toys", ["gA child (synthetic)"])).toMatchObject({ ok: true });
    expect(mentionsName("Aaravi was not mentioned", CHILD)).toBe(false);
  });

  it.each([
    "Waited 2 hours 30 minutes, worth it",
    "Great therapist, 10/10, visit on 12/11/2026",
    "Very patient. Explained the home plan clearly.",
    "చాలా బాగా వివరించారు",
    "बहुत अच्छे डॉक्टर",
    "Fee was Rs 1500 and parking was easy",
  ])("accepts ordinary comments: %s", (comment) => {
    expect(screenComment(comment, CHILD)).toEqual({ ok: true, comment, needsReview: false });
  });

  it.each(["What a fraud", "total SCAM clinic", "fucking late again", "doctor is a chutiya", "బాగా లేదు, దొంగ"])("abuse list -> accepted for review: %s", (comment) => {
    expect(isAbusive(comment)).toBe(true);
    expect(screenComment(comment, CHILD)).toMatchObject({ ok: true, needsReview: true });
  });

  it("empty comments become null; whitespace is tidied", () => {
    expect(screenComment("   ", CHILD)).toEqual({ ok: true, comment: null, needsReview: false });
    expect(screenComment(null, CHILD)).toEqual({ ok: true, comment: null, needsReview: false });
    expect(screenComment("  Good   visit \n\n\n\n Thanks ", CHILD)).toMatchObject({ comment: "Good visit \n\n Thanks" });
  });
});

describe("display threshold (FR-5, D-2)", () => {
  it("average from 3 published ratings, else New on DoctorNearMe", () => {
    expect(ratingBadge(null)).toEqual({ kind: "new" });
    expect(ratingBadge({ rating_avg: 5, rating_count: 2 })).toEqual({ kind: "new" });
    expect(ratingBadge({ rating_avg: null, rating_count: 7 })).toEqual({ kind: "new" });
    expect(ratingBadge({ rating_avg: "4.5", rating_count: 4 })).toEqual({ kind: "average", average: "4.5", count: 4 });
    expect(ratingBadge({ rating_avg: 4, rating_count: 3 })).toEqual({ kind: "average", average: "4.0", count: 3 });
  });

  it("comments show month and year only", () => {
    expect(monthYear("2026-11-13T20:00:00Z", "en", "Asia/Kolkata")).toBe("Nov 2026");
    expect(monthYear("2026-11-30T20:00:00Z", "en", "Asia/Kolkata")).toBe("Dec 2026");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => ({ get: () => null }),
}));

type Json = Record<string, unknown>;
async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

describe.skipIf(!enabled)("ratings (database, route handlers)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let providerA: TestProvider;
  let providerFresh: TestProvider;
  let free30: string;
  let guardianA: { user: TestUser; childId: string };
  let guardianB: { user: TestUser; childId: string };
  let admin: TestUser;
  let routes: {
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    complete: typeof import("@/app/api/appointments/[id]/complete/route");
    rating: typeof import("@/app/api/appointments/[id]/rating/route");
    report: typeof import("@/app/api/ratings/[id]/report/route");
    moderate: typeof import("@/app/api/admin/ratings/[id]/route");
  };
  let offset = 0;
  const testUsers: TestUser[] = [];

  const as = (user: TestUser | null) => {
    session.user = user;
  };
  const rate = (id: string, body: unknown) => call(routes.rating.POST, post(`http://localhost/api/appointments/${id}/rating`, body), { id });
  const edit = (id: string, body: unknown) => call(routes.rating.PATCH, post(`http://localhost/api/appointments/${id}/rating`, body, "PATCH"), { id });
  const report = (id: string, reason: string) => call(routes.report.POST, post(`http://localhost/api/ratings/${id}/report`, { reason }), { id });
  const moderate = (id: string, body: unknown) => call(routes.moderate.POST, post(`http://localhost/api/admin/ratings/${id}`, body), { id });
  const summary = async (profileId: string) =>
    (await sql<{ rating_avg: string; rating_count: number }[]>`select rating_avg::text, rating_count from provider_rating_summary where provider_profile_id = ${profileId}`)[0] ?? null;

  /**
   * An appointment written directly (SQL time travel): `completed` (via an update, which fires the rate-prompt trigger,
   * plus a completion event `completedDaysAgo` days ago) or `confirmed` in the past.
   */
  async function pastAppointment(p: TestProvider, g: { user: TestUser; childId: string }, opts: { completedDaysAgo?: number; status?: "completed" | "confirmed" } = {}): Promise<string> {
    const daysAgo = opts.completedDaysAgo ?? 0;
    offset += 1;
    const [row] = await sql<{ id: string }[]>`
      insert into appointments (provider_profile_id, org_id, service_snapshot, child_id, guardian_user_id, slot, status)
      values (${p.profileId}, ${p.orgId},
              ${sql.json({ name: "Session (synthetic)", duration_min: 30, mode: "in_clinic", fee_inr: 0, payment_mode: "free", provider_name: `Dr ${p.slug}`, location: null })},
              ${g.childId}, ${g.user.id},
              tstzrange(now() - make_interval(days => ${daysAgo}, hours => ${offset + 2}), now() - make_interval(days => ${daysAgo}, hours => ${offset + 2}) + interval '30 minutes', '[)'),
              'confirmed')
      returning id`;
    if ((opts.status ?? "completed") === "completed") {
      await sql`update appointments set status = 'completed' where id = ${row.id}`;
      await sql`
        insert into appointment_events (appointment_id, from_status, to_status, actor_user_id, actor_kind, created_at)
        values (${row.id}, 'confirmed', 'completed', ${p.user.id}, 'provider', now() - make_interval(days => ${daysAgo}))`;
    }
    return row.id;
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t036r");
    providerA = await world.provider("pa");
    providerFresh = await world.provider("pfresh");
    free30 = await world.service(providerA, { duration: 30, payment: "free" });
    guardianA = await world.guardian("ga");
    guardianB = await world.guardian("gb");
    admin = await world.user("admin", "platform_admin");
    testUsers.push(providerA.user, providerFresh.user, guardianA.user, guardianB.user, admin);
    await sql`update children set display_name = 'Aarav Reddy' where id = ${guardianA.childId}`;
    routes = {
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      complete: await import("@/app/api/appointments/[id]/complete/route"),
      rating: await import("@/app/api/appointments/[id]/rating/route"),
      report: await import("@/app/api/ratings/[id]/report/route"),
      moderate: await import("@/app/api/admin/ratings/[id]/route"),
    };
  });

  beforeEach(async () => {
    const { holdLimiter } = await import("@/lib/booking/rate-limit");
    holdLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql && world) {
      const ids = testUsers.map((u) => u.id);
      if (ids.length) await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'rating' and actor_user_id in ${tx(ids)}`);
      await world.cleanup();
    }
    await sql?.end({ timeout: 5 });
  });

  describe("E-1: complete -> prompt -> rate -> summary", () => {
    it("completing through the provider route enqueues the rate prompt for 2 h later; fan-out reaches the guardian", async () => {
      as(guardianA.user);
      const h = await call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: free30, start: futureSlot(5).toISOString(), idempotency_key: key() }));
      expect(h.status, JSON.stringify(h.json)).toBe(201);
      const id = h.json.appointment_id as string;
      expect((await call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: guardianA.childId }), { id })).status).toBe(200);
      // Time travel: the visit started an hour ago (the slot moves into the past, out of every other test's way).
      await sql`update appointments set slot = tstzrange(now() - interval '400 days', now() - interval '400 days' + interval '30 minutes', '[)') where id = ${id}`;
      as(providerA.user);
      const done = await call(routes.complete.POST, post(`http://localhost/api/appointments/${id}/complete`, { status: "completed" }), { id });
      expect(done.status, JSON.stringify(done.json)).toBe(200);

      const [event] = await sql<{ id: string; topic: string; deliver_after: Date; payload: Json; status: string }[]>`
        select id::text, topic, deliver_after, payload, status from outbox_events where dedup_key = ${`appt:${id}:rate_prompt`}`;
      expect(event).toMatchObject({ topic: "appointment.rate_prompt", status: "pending" });
      expect(Object.keys(event.payload).sort()).toEqual(["appointment_id", "provider_name"]);
      const delay = event.deliver_after.getTime() - Date.now();
      expect(delay).toBeGreaterThan(119 * 60_000);
      expect(delay).toBeLessThan(121 * 60_000);

      const { fanOutDue } = await import("@/lib/notify/worker");
      await fanOutDue(sql, { eventIds: [event.id] });
      expect((await sql`select 1 from notifications where event_id = ${event.id}`).length).toBe(0); // not due yet
      await sql`update outbox_events set deliver_after = now() where id = ${event.id}`;
      await fanOutDue(sql, { eventIds: [event.id] });
      const rows = await sql<{ recipient_user_id: string; channel: string; title: string; link: string }[]>`
        select recipient_user_id, channel, title, link from notifications where event_id = ${event.id} order by channel`;
      expect(rows.map((r) => r.channel)).toEqual(["email", "in_app"]);
      expect(rows.every((r) => r.recipient_user_id === guardianA.user.id)).toBe(true);
      expect(rows[1]).toMatchObject({ title: "How was your visit?", link: `/family/appointments/${id}/rate` });

      // The completed appointment can now be rated through the API.
      as(guardianA.user);
      const r = await rate(id, { stars: 5, comment: "Very patient and kind. Clear home plan." });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json.rating).toMatchObject({ stars: 5, status: "published" });
    });

    it("the prompt is not sent once the visit is rated (recipients re-checked at fan-out)", async () => {
      const id = await pastAppointment(providerFresh, guardianB);
      as(guardianB.user);
      expect((await rate(id, { stars: 3 })).status).toBe(201);
      const [event] = await sql<{ id: string }[]>`select id::text from outbox_events where dedup_key = ${`appt:${id}:rate_prompt`}`;
      await sql`update outbox_events set deliver_after = now() where id = ${event.id}`;
      const { fanOutDue } = await import("@/lib/notify/worker");
      await fanOutDue(sql, { eventIds: [event.id] });
      expect((await sql`select 1 from notifications where event_id = ${event.id}`).length).toBe(0);
    });

    it("5, 4, 5 from guardian A and 4 from guardian B -> 4.5 from 4 published ratings; search_providers fills the columns", async () => {
      // One 5 already from the first test.
      const a2 = await pastAppointment(providerA, guardianA);
      const a3 = await pastAppointment(providerA, guardianA);
      const b1 = await pastAppointment(providerA, guardianB);
      as(guardianA.user);
      expect((await rate(a2, { stars: 4 })).status).toBe(201);
      expect((await rate(a3, { stars: 5, comment: "Good with toddlers, on time." })).status).toBe(201);
      as(guardianB.user);
      expect((await rate(b1, { stars: 4, comment: "Helpful advice." })).status).toBe(201);
      expect(await summary(providerA.profileId)).toEqual({ rating_avg: "4.5", rating_count: 4 });

      const { getRatingSummary, listPublicComments } = await import("@/lib/ratings/store");
      const s = await getRatingSummary(providerA.profileId);
      expect(ratingBadge(s)).toEqual({ kind: "average", average: "4.5", count: 4 });
      const comments = await listPublicComments(providerA.profileId);
      expect(comments.map((c) => c.comment)).toEqual(["Helpful advice.", "Good with toddlers, on time.", "Very patient and kind. Clear home plan."]);
      expect(Object.keys(comments[0]).sort()).toEqual(["comment", "created_at", "id"]);

      const [hit] = await sql<{ rating_avg: string | null; rating_count: number }[]>`
        select rating_avg::text, rating_count from search_providers(17.41, 78.44, 5, null, null, 'any', 100, 0, true) where profile_id = ${providerA.profileId}`;
      expect(hit).toEqual({ rating_avg: "4.5", rating_count: 4 });
    });

    it("a provider with fewer than 3 ratings shows New on DoctorNearMe (search returns no average)", async () => {
      // providerFresh has guardian B's 3 from the prompt test; add one more -> 2 ratings.
      const id = await pastAppointment(providerFresh, guardianA);
      as(guardianA.user);
      expect((await rate(id, { stars: 5 })).status).toBe(201);
      expect(await summary(providerFresh.profileId)).toEqual({ rating_avg: "4.0", rating_count: 2 });
      const [hit] = await sql<{ rating_avg: string | null; rating_count: number }[]>`
        select rating_avg::text, rating_count from search_providers(17.41, 78.44, 5, null, null, 'any', 100, 0, true) where profile_id = ${providerFresh.profileId}`;
      expect(hit).toEqual({ rating_avg: null, rating_count: 2 });
      const { getRatingSummary } = await import("@/lib/ratings/store");
      expect(ratingBadge(await getRatingSummary(providerFresh.profileId))).toEqual({ kind: "new" });
    });
  });

  describe("E-2: negatives (FR-3, FR-4)", () => {
    it("not completed / someone else's / unknown / not a guardian -> 403; anonymous -> 401; twice -> 409", async () => {
      const confirmed = await pastAppointment(providerA, guardianA, { status: "confirmed" });
      const ownedByA = await pastAppointment(providerA, guardianA);
      as(guardianA.user);
      expect(await rate(confirmed, { stars: 5 })).toEqual({ status: 403, json: { error: NOT_ELIGIBLE } });
      as(guardianB.user);
      expect(await rate(ownedByA, { stars: 1 })).toEqual({ status: 403, json: { error: NOT_ELIGIBLE } });
      expect(await rate("00000000-0000-4000-8000-000000000000", { stars: 1 })).toEqual({ status: 403, json: { error: NOT_ELIGIBLE } });
      expect(await rate("not-a-uuid", { stars: 1 })).toEqual({ status: 403, json: { error: NOT_ELIGIBLE } });
      as(providerA.user);
      expect((await rate(ownedByA, { stars: 5 })).status).toBe(403);
      as(null);
      expect((await rate(ownedByA, { stars: 5 })).status).toBe(401);
      as(guardianA.user);
      expect((await rate(ownedByA, { stars: 0 })).status).toBe(400);
      expect((await rate(ownedByA, { stars: 4.5 })).status).toBe(400);
      expect((await rate(ownedByA, { stars: 5, comment: "x".repeat(501) })).status).toBe(400);
      expect((await rate(ownedByA, { stars: 5, guardian_user_id: guardianB.user.id })).status).toBe(400);
      expect((await rate(ownedByA, { stars: 5 })).status).toBe(201);
      expect(await rate(ownedByA, { stars: 4 })).toEqual({ status: 409, json: { error: "You already rated this visit" } });
      // Concurrent duplicates: exactly one wins.
      const race = await pastAppointment(providerA, guardianA);
      const results = await Promise.all([rate(race, { stars: 5 }), rate(race, { stars: 4 }), rate(race, { stars: 3 })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect((await sql`select 1 from ratings where appointment_id = ${race}`).length).toBe(1);
    });

    it("30-day window: completed 31 days ago -> 403, 29 days ago -> 201", async () => {
      const old = await pastAppointment(providerA, guardianA, { completedDaysAgo: 31 });
      const recent = await pastAppointment(providerA, guardianA, { completedDaysAgo: 29 });
      as(guardianA.user);
      expect((await rate(old, { stars: 5 })).status).toBe(403);
      expect((await rate(recent, { stars: 5 })).status).toBe(201);
    });

    it("phone number, email, link or the child's name -> 422 and nothing saved; abuse words -> pending_review", async () => {
      const id = await pastAppointment(providerA, guardianA);
      as(guardianA.user);
      for (const comment of ["Call 9876543210 for details", "Aarav liked it", "aarav reddy enjoyed", "mail me at a.b@example.test", "see www.example.com"]) {
        expect(await rate(id, { stars: 5, comment })).toEqual({ status: 422, json: { error: SCREEN_REJECTED } });
      }
      expect((await sql`select 1 from ratings where appointment_id = ${id}`).length).toBe(0);
      const r = await rate(id, { stars: 1, comment: "This place is a scam" });
      expect(r.status).toBe(201);
      expect(r.json.rating).toMatchObject({ status: "pending_review" });
      const [row] = await sql<{ status: string; review_reason: string }[]>`select status, review_reason from ratings where appointment_id = ${id}`;
      expect(row).toEqual({ status: "pending_review", review_reason: "abuse_screen" });
      // Not public, not counted.
      const { listPublicComments } = await import("@/lib/ratings/store");
      expect((await listPublicComments(providerA.profileId)).some((c) => c.comment.includes("scam"))).toBe(false);
      // Editing the comment to clean text publishes it.
      const fixed = await edit(id, { comment: "Long wait, but the advice was useful." });
      expect(fixed.status).toBe(200);
      expect(fixed.json.rating).toMatchObject({ status: "published", stars: 1 });
      await sql`update ratings set status = 'hidden' where appointment_id = ${id}`; // keep the 4.5 summary of E-1 intact
    });

    it("PATCH: own rating within 7 days; screened; 403 after 7 days; others 403", async () => {
      const id = await pastAppointment(providerFresh, guardianA);
      as(guardianA.user);
      expect((await edit(id, { stars: 4 })).status).toBe(403); // nothing to edit yet
      expect((await rate(id, { stars: 2 })).status).toBe(201);
      const changed = await edit(id, { stars: 3, comment: "Better on the second look." });
      expect(changed.status).toBe(200);
      expect(changed.json.rating).toMatchObject({ stars: 3, comment: "Better on the second look." });
      expect((await sql<{ edited_at: Date | null }[]>`select edited_at from ratings where appointment_id = ${id}`)[0].edited_at).not.toBeNull();
      expect((await edit(id, { comment: "Text me on 98765 43210" })).status).toBe(422);
      expect((await edit(id, {})).status).toBe(400);
      as(guardianB.user);
      expect((await edit(id, { stars: 1 })).status).toBe(403);
      as(guardianA.user);
      await sql`update ratings set created_at = now() - interval '8 days' where appointment_id = ${id}`;
      expect(await edit(id, { stars: 5 })).toEqual({ status: 403, json: { error: "Ratings can be changed only within 7 days" } });
      await sql`delete from ratings where appointment_id = ${id}`;
    });
  });

  describe("E-3: moderation (FR-6)", () => {
    it("provider reports -> pending_review (off the profile); admin publishes -> visible; hide needs a note; provider on the admin API -> 403", async () => {
      const [target] = await sql<{ id: string }[]>`
        select r.id from ratings r where r.provider_profile_id = ${providerA.profileId} and r.comment = 'Helpful advice.'`;
      const before = await summary(providerA.profileId);

      as(providerFresh.user); // another provider: 404
      expect((await report(target.id, "Not my patient")).status).toBe(404);
      as(guardianA.user);
      expect((await report(target.id, "Not fair")).status).toBe(403);
      as(providerA.user);
      expect((await report(target.id, "x")).status).toBe(400);
      const reported = await report(target.id, "This family never visited me");
      expect(reported).toEqual({ status: 200, json: { rating: { id: target.id, status: "pending_review" } } });
      expect((await report(target.id, "Again")).status).toBe(200); // idempotent while in review
      const { listPublicComments, listProviderRatings } = await import("@/lib/ratings/store");
      expect((await listPublicComments(providerA.profileId)).some((c) => c.id === target.id)).toBe(false);
      expect((await summary(providerA.profileId))!.rating_count).toBe(before!.rating_count - 1);
      expect((await listProviderRatings(providerA.profileId)).find((r) => r.id === target.id)).toMatchObject({ reported: true });

      // The guardian may edit, but a reported rating stays in review.
      as(guardianB.user);
      const [appt] = await sql<{ appointment_id: string }[]>`select appointment_id from ratings where id = ${target.id}`;
      expect((await edit(appt.appointment_id, { stars: 4 })).json.rating).toMatchObject({ status: "pending_review" });

      as(providerA.user);
      expect(await moderate(target.id, { action: "publish" })).toEqual({ status: 403, json: { error: "Platform admin access required" } });
      as(guardianB.user);
      expect((await moderate(target.id, { action: "hide", note: "abusive" })).status).toBe(403);

      as(admin);
      expect((await moderate(target.id, { action: "hide" })).status).toBe(400);
      expect((await moderate("00000000-0000-4000-8000-000000000000", { action: "publish" })).status).toBe(404);
      const published = await moderate(target.id, { action: "publish", note: "Checked the booking: genuine visit." });
      expect(published).toEqual({ status: 200, json: { rating: { id: target.id, status: "published" } } });
      expect((await listPublicComments(providerA.profileId)).some((c) => c.id === target.id)).toBe(true);
      expect(await summary(providerA.profileId)).toEqual(before);

      // Admin hides an abusive published rating with a note; a hidden rating cannot be reported or edited.
      const hidden = await moderate(target.id, { action: "hide", note: "Personal attack on staff" });
      expect(hidden.json.rating).toMatchObject({ status: "hidden" });
      as(providerA.user);
      expect((await report(target.id, "Still bad")).status).toBe(409);
      as(guardianB.user);
      expect((await edit(appt.appointment_id, { stars: 5 })).status).toBe(409);
      as(admin);
      expect((await moderate(target.id, { action: "publish" })).status).toBe(200);

      const audit = await sql<{ action: string; actor_user_id: string; actor_role: string; details: Json }[]>`
        select action, actor_user_id, actor_role, details from audit_events where entity = 'rating' and entity_id = ${target.id} order by id`;
      expect(audit.map((a) => a.action)).toEqual(["rating.created", "rating.reported", "rating.updated", "rating.moderated", "rating.moderated", "rating.moderated"]);
      expect(audit.find((a) => a.action === "rating.reported")).toMatchObject({ actor_user_id: providerA.user.id, actor_role: "provider" });
      expect(audit.filter((a) => a.action === "rating.moderated").every((a) => a.actor_user_id === admin.id && a.actor_role === "platform_admin")).toBe(true);
      // No comment text or notes in the audit log.
      expect(JSON.stringify(audit)).not.toMatch(/Helpful|genuine|Personal attack/);
    });

    it("admin queue shows the guardian's identity; public and provider views never do (NFR-1)", async () => {
      const { listRatingsForAdmin, listProviderRatings, listPublicComments } = await import("@/lib/ratings/store");
      const queue = await listRatingsForAdmin("published");
      const mine = queue.find((r) => r.provider_slug === providerA.slug);
      expect(mine?.guardian_email).toMatch(/@example\.test$/);
      const providerView = JSON.stringify(await listProviderRatings(providerA.profileId));
      const publicView = JSON.stringify(await listPublicComments(providerA.profileId));
      for (const view of [providerView, publicView]) {
        expect(view).not.toContain(guardianA.user.id);
        expect(view).not.toContain(guardianA.user.email);
        expect(view).not.toContain("guardian");
      }
    });

    it("a failed audit write saves nothing (503)", async () => {
      const id = await pastAppointment(providerFresh, guardianB);
      vi.stubEnv("AUDIT_FAIL_ACTIONS", "rating.created");
      as(guardianB.user);
      expect(await rate(id, { stars: 5 })).toEqual({ status: 503, json: { error: "Could not save. Please try again." } });
      vi.stubEnv("AUDIT_FAIL_ACTIONS", "");
      expect((await sql`select 1 from ratings where appointment_id = ${id}`).length).toBe(0);
    });
  });

  describe("schema and privacy (FR-1, NFR-2)", () => {
    it("the database refuses ratings for appointments that are not the guardian's completed ones", async () => {
      const confirmed = await pastAppointment(providerA, guardianB, { status: "confirmed" });
      await expect(sql`insert into ratings (appointment_id, provider_profile_id, guardian_user_id, stars) values (${confirmed}, ${providerA.profileId}, ${guardianB.user.id}, 5)`).rejects.toThrow(/rating_not_eligible/);
      const done = await pastAppointment(providerA, guardianB);
      await expect(sql`insert into ratings (appointment_id, provider_profile_id, guardian_user_id, stars) values (${done}, ${providerA.profileId}, ${guardianA.user.id}, 5)`).rejects.toThrow(/rating_not_eligible/);
      await expect(sql`insert into ratings (appointment_id, provider_profile_id, guardian_user_id, stars) values (${done}, ${providerA.profileId}, ${guardianB.user.id}, 6)`).rejects.toThrow(/ratings_stars_check/);
    });

    it("registry: exported for the guardian, deleted on full erasure and with the guardian's account", async () => {
      const { REGISTRY, categoriesForScope } = await import("@/lib/privacy/registry");
      const category = REGISTRY.find((c) => c.key === "ratings")!;
      expect(categoriesForScope("everything").map((c) => c.key).indexOf("ratings")).toBeLessThan(categoriesForScope("everything").map((c) => c.key).indexOf("appointments"));
      const exported = (await category.export!({ sql, childId: guardianA.childId, guardianUserId: guardianA.user.id }))!.data as Json[];
      expect(exported.length).toBeGreaterThan(0);
      expect(exported.every((r) => typeof r.stars === "number")).toBe(true);
      expect((await category.export!({ sql, childId: guardianA.childId, guardianUserId: guardianB.user.id }))!.data).toEqual([]);

      const g = await world.guardian("gerase");
      testUsers.push(g.user);
      const id = await pastAppointment(providerFresh, g);
      as(g.user);
      expect((await rate(id, { stars: 4 })).status).toBe(201);
      await sql.begin((tx) => category.erase!.rows!(tx, { childId: g.childId, requestId: "00000000-0000-4000-8000-000000000000", scope: "everything", requestedBy: g.user.id, caseIds: [] }));
      expect((await sql`select 1 from ratings where appointment_id = ${id}`).length).toBe(0);

      const gone = await world.guardian("gdelete");
      const id2 = await pastAppointment(providerFresh, gone);
      as(gone.user);
      expect((await rate(id2, { stars: 4 })).status).toBe(201);
      const db = (await import("@/lib/db")).supabaseAdmin();
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where actor_user_id = ${gone.user.id}`);
      const { error } = await db.auth.admin.deleteUser(gone.user.id);
      expect(error).toBeNull();
      expect((await sql`select 1 from ratings where appointment_id = ${id2}`).length).toBe(0);
    });
  });
});
