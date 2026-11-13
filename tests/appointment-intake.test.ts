// Ticket 035: appointment-scoped pre-consult intake against the real database, through the route handlers and the
// outbox worker: case reuse vs creation (and across orgs), consumer re-run idempotency, the confirmation's link or
// consent hint, consent granted later, attempt expiry / revocation on cancel / move on reschedule, start and
// completion re-checking consent, duplicate webhooks, cross-appointment tokens and the generic brief (schema + health
// profile check). Synthetic users only; skipped without DATABASE_URL.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingWorld, futureSlot, key, type TestProvider } from "./helpers/booking";
import { purgeTestAudit } from "./helpers/audit";
import { ctx, post, type TestUser } from "./helpers/world";
import genericIntakeJson from "@/schemas/generic-intake.json";
import { attemptLinkState } from "@/lib/intake/attempts";
import { checkAgainstProfile, GenericIntakeBriefSchema, StoredGenericBriefSchema } from "@/lib/intake/generic";
import { defaultIntakeKind } from "@/lib/booking/intake-defaults";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string }, cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    getAll: () => [...session.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => session.cookies.has(name),
    set: () => {},
  }),
  headers: async () => ({ get: () => null }),
}));

const APP = "https://app.doctornearme.test";
const SECRET = "whsec-test-035";
const CHILD_DEV_AGENT = "agent_childdev_test_035";
const GENERIC_AGENT = "agent_generic_test_035";
const EXPIRED = "This link has expired";
const CONSENT_TEXT = "Allow the AI intake call in your DoctorNearMe app to prepare for this visit.";
const LINK_TEXT = "Before your visit, please take a short voice call with our AI assistant: ";

type Json = Record<string, unknown>;
async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

// ---------------------------------------------------------------------------------------------------------
// Pure rules (no database)

describe("appointment intake: pure rules", () => {
  const base = { status: "issued" as const, appointment_status: "confirmed", expires_at: new Date(Date.now() + 3_600_000).toISOString() };

  it("link state: active until the appointment start, revoked once the appointment is not confirmed", () => {
    expect(attemptLinkState(base)).toBe("active");
    expect(attemptLinkState({ ...base, expires_at: new Date(Date.now() - 1000).toISOString() })).toBe("expired");
    expect(attemptLinkState({ ...base, appointment_status: "cancelled" })).toBe("revoked");
    expect(attemptLinkState({ ...base, status: "revoked" })).toBe("revoked");
    expect(attemptLinkState({ ...base, status: "completed", appointment_status: "cancelled" })).toBe("completed");
  });

  it("completion grace only for a started call (also once the provider marked the visit completed)", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(attemptLinkState({ ...base, expires_at: past }, Date.now(), 3_600_000)).toBe("expired");
    expect(attemptLinkState({ ...base, status: "started", expires_at: past }, Date.now(), 3_600_000)).toBe("active");
    expect(attemptLinkState({ ...base, status: "started", expires_at: past, appointment_status: "completed" }, Date.now(), 3_600_000)).toBe("active");
    expect(attemptLinkState({ ...base, status: "started", appointment_status: "completed" })).toBe("revoked");
  });

  it("D-4 default intake kind by provider type", () => {
    for (const t of ["developmental_pediatrician", "child_psychiatrist", "child_psychologist", "speech_language_pathologist", "occupational_therapist", "aba_therapist", "special_educator"]) {
      expect(defaultIntakeKind(t)).toBe("child_dev");
    }
    expect(defaultIntakeKind("physiotherapist")).toBe("generic");
    expect(defaultIntakeKind("pediatrician")).toBe("generic");
  });

  it("generic brief schema: fixture valid, JSON schema mirrors the zod keys, invalid output rejected", () => {
    const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures/gemini/generic-intake.json"), "utf8"));
    expect(GenericIntakeBriefSchema.safeParse(fixture).success).toBe(true);
    expect([...genericIntakeJson.brief.required].sort()).toEqual(Object.keys(GenericIntakeBriefSchema.shape).sort());
    expect(Object.keys(genericIntakeJson.brief.properties).sort()).toEqual(Object.keys(GenericIntakeBriefSchema.shape).sort());
    expect(GenericIntakeBriefSchema.safeParse({ ...fixture, questions_for_provider: [] }).success).toBe(false);
    expect(GenericIntakeBriefSchema.safeParse({ ...fixture, reason_for_visit: "" }).success).toBe(false);
    expect(GenericIntakeBriefSchema.safeParse({ ...fixture, summary: Array(130).fill("word").join(" ") }).success).toBe(false);
  });

  it("medicines and allergies are checked against the health profile", () => {
    const brief = { medications: [{ name: "Paracetamol syrup", details: "" }], allergies: [{ substance: "Peanuts", reaction: "hives" }] };
    const check = checkAgainstProfile(brief, {
      recorded: true,
      version: 3,
      medications: [{ name: "Iron syrup" }],
      allergies: [{ substance: "peanut" }],
    });
    expect(check.medications).toEqual([{ name: "Paracetamol syrup", match: "not_in_profile" }]);
    expect(check.allergies).toEqual([{ substance: "Peanuts", match: "in_profile" }]);
    expect(check.profile_only).toEqual({ medications: ["Iron syrup"], allergies: [] });
    expect(checkAgainstProfile(brief, { recorded: false, version: 0, medications: [], allergies: [] }).medications[0].match).toBe("profile_not_recorded");
  });
});

// ---------------------------------------------------------------------------------------------------------
// Database

describe.skipIf(!enabled)("appointment intake (database, route handlers, outbox)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let providerA: TestProvider;
  let providerB: TestProvider;
  let childDevA: string;
  let genericA: string;
  let childDevB: string;
  let guardian: TestUser;
  let consented: string; // child with ai_intake_call
  let notConsented: string;
  let linkConsented: string;
  let linkNotConsented: string;
  let slotHours = 30;
  const appointmentIds: string[] = [];
  let routes: {
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    cancel: typeof import("@/app/api/appointments/[id]/cancel/route");
    reschedule: typeof import("@/app/api/appointments/[id]/reschedule/route");
    start: typeof import("@/app/api/intake/a/[token]/start/route");
    complete: typeof import("@/app/api/intake/a/[token]/complete/route");
    simulate: typeof import("@/app/api/dev/simulate-intake/a/[token]/route");
    webhook: typeof import("@/app/api/webhooks/elevenlabs/route");
    services: typeof import("@/app/api/provider/services/route");
  };
  let tokens: typeof import("@/lib/intake/attempt-token");
  let caseLink: typeof import("@/lib/booking/case-link");
  let processing: typeof import("@/lib/intake/appointment-process");
  let worker: typeof import("@/lib/notify/worker");
  let signature: typeof import("@/lib/intake/signature");

  const as = (user: TestUser | null) => {
    session.user = user;
    session.cookies.clear();
  };
  const nextStart = () => {
    slotHours += 3;
    return futureSlot(slotHours);
  };

  async function book(serviceId: string, childId: string, start = nextStart()): Promise<string> {
    as(guardian);
    const h = await call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: serviceId, start: start.toISOString(), idempotency_key: key() }));
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    const id = h.json.appointment_id as string;
    const c = await call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: childId }), { id });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    appointmentIds.push(id);
    return id;
  }

  /** Fans out (and delivers) the given events; retried while another suite's worker holds them. */
  async function drain(eventIds: string[]) {
    for (let i = 0; i < 20; i++) {
      await worker.runOutbox({ sql, eventIds, appUrl: APP, senders: { email: async () => ({ status: "sent", providerMessageId: "test" }), whatsapp: async () => ({ status: "skipped", reason: "whatsapp_not_configured" }) } });
      const [{ pending }] = await sql<{ pending: number }[]>`
        select count(*)::int as pending from outbox_events where id in ${sql(eventIds)} and status = 'pending'`;
      if (pending === 0) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("outbox events still pending");
  }
  const eventsOf = (appointmentId: string, topic: string) =>
    sql<{ id: string; payload: Json; status: string }[]>`
      select id::text, payload, status from outbox_events where topic = ${topic} and payload ->> 'appointment_id' = ${appointmentId} order by id`;
  async function drainConfirmation(appointmentId: string, topic = "appointment.confirmed") {
    const events = await eventsOf(appointmentId, topic);
    expect(events.length).toBe(1);
    await drain(events.map((e) => e.id));
    return (await eventsOf(appointmentId, topic))[0];
  }
  const appointment = async (id: string) =>
    (await sql<{ case_id: string | null; status: string; starts_at: Date }[]>`select case_id, status, lower(slot) as starts_at from appointments where id = ${id}`)[0];
  const attempts = (appointmentId: string) =>
    sql<{ id: string; status: string; agent_kind: string; token_hash: string; expires_at: Date; case_id: string; revoked_reason: string | null }[]>`
      select id, status, agent_kind, token_hash, expires_at, case_id, revoked_reason from intake_attempts where appointment_id = ${appointmentId} order by created_at`;
  const guardianNotes = (topic: string, appointmentId: string) =>
    sql<{ body: string; channel: string }[]>`
      select n.body, n.channel from notifications n join outbox_events e on e.id = n.event_id
      where e.topic = ${topic} and e.payload ->> 'appointment_id' = ${appointmentId} and n.recipient_user_id = ${guardian.id} order by n.channel`;

  const start = (token: string, body: Json = {}) => call(routes.start.POST, post(`http://localhost/api/intake/a/${token}/start`, body), { token });
  const complete = (token: string, conversationId: string) =>
    call(routes.complete.POST, post(`http://localhost/api/intake/a/${token}/complete`, { conversation_id: conversationId }), { token });
  const simulate = (token: string) => call(routes.simulate.POST, post(`http://localhost/api/dev/simulate-intake/a/${token}`), { token });
  async function webhook(data: unknown) {
    const body = JSON.stringify({ type: "post_call_transcription", data });
    const res = await routes.webhook.POST(
      new Request("http://localhost/api/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": signature.signPayload(body, SECRET) }, body }),
    );
    return { status: res.status, json: (await res.json()) as Json };
  }
  const tokenOf = (attemptId: string) => tokens.intakeAttemptToken(attemptId);

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("INTAKE_LINK_SECRET", "test-intake-link-secret-035");
    vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("ELEVENLABS_AGENT_ID", CHILD_DEV_AGENT);
    vi.stubEnv("ELEVENLABS_GENERIC_INTAKE_AGENT_ID", GENERIC_AGENT);
    vi.stubEnv("DEMO_FIXTURES_DIR", "demo/fixtures");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t035i");
    providerA = await world.provider("pa");
    providerB = await world.provider("pb");
    childDevA = await world.service(providerA, { duration: 30, payment: "free", name: "Development consult (synthetic)" });
    genericA = await world.service(providerA, { duration: 30, payment: "at_clinic", fee: 500, name: "Knee physio (synthetic)" });
    childDevB = await world.service(providerB, { duration: 30, payment: "free", name: "Speech consult (synthetic)" });
    await sql`update services set intake_kind = 'child_dev' where id in ${sql([childDevA, childDevB])}`;
    await sql`update services set intake_kind = 'generic' where id = ${genericA}`;

    guardian = await world.user("g", "guardian", { phoneVerified: true });
    const [c1] = await sql<{ id: string }[]>`
      insert into children (display_name, date_of_birth, source, created_by) values ('Anaya (synthetic)', '2018-04-01', 'guardian', ${guardian.id}) returning id`;
    const [c2] = await sql<{ id: string }[]>`
      insert into children (display_name, date_of_birth, source, created_by) values ('Ravi (synthetic)', '2022-01-10', 'guardian', ${guardian.id}) returning id`;
    consented = c1.id;
    notConsented = c2.id;
    world.trackChild(consented);
    world.trackChild(notConsented);
    linkConsented = await world.link(consented, guardian);
    linkNotConsented = await world.link(notConsented, guardian);
    await world.grant(consented, guardian, linkConsented, ["ai_intake_call"]);
    await sql`
      insert into child_health_profiles (child_id, allergies, medications, updated_by)
      values (${consented}, ${sql.json([{ substance: "Peanut", reaction: "hives", severity: "severe" }])},
              ${sql.json([{ name: "Iron syrup", dose: "5 ml", frequency: "daily" }])}, ${guardian.id})`;

    routes = {
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      cancel: await import("@/app/api/appointments/[id]/cancel/route"),
      reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
      start: await import("@/app/api/intake/a/[token]/start/route"),
      complete: await import("@/app/api/intake/a/[token]/complete/route"),
      simulate: await import("@/app/api/dev/simulate-intake/a/[token]/route"),
      webhook: await import("@/app/api/webhooks/elevenlabs/route"),
      services: await import("@/app/api/provider/services/route"),
    };
    tokens = await import("@/lib/intake/attempt-token");
    caseLink = await import("@/lib/booking/case-link");
    processing = await import("@/lib/intake/appointment-process");
    worker = await import("@/lib/notify/worker");
    signature = await import("@/lib/intake/signature");
  });

  beforeEach(async () => {
    const { holdLimiter } = await import("@/lib/booking/rate-limit");
    holdLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (sql) {
      const ids = appointmentIds.length ? appointmentIds : ["00000000-0000-4000-8000-000000000000"];
      const att = await sql<{ id: string }[]>`select id from intake_attempts where appointment_id in ${sql(ids)}`;
      await sql`delete from outbox_events where aggregate_type = 'intake_attempt' and payload ->> 'appointment_id' in ${sql(ids)}`;
      if (att.length) {
        await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'intake_attempt' and entity_id in ${tx(att.map((a) => a.id))}`);
      }
      const cases = await sql<{ id: string }[]>`select id from cases where org_id in ${sql([providerA.orgId, providerB.orgId])}`;
      if (cases.length) await purgeTestAudit(sql, (tx) => tx`delete from audit_events where case_id in ${tx(cases.map((c) => c.id))}`);
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("E-1 Child-Dev: case created in the org with the provider assigned, link in the confirmation, call -> brief on the case", async () => {
    const id = await book(childDevA, consented);
    const event = await drainConfirmation(id);
    const appt = await appointment(id);
    expect(appt.case_id).toBeTruthy();
    const [kase] = await sql<{ org_id: string; child_id: string; child_alias: string; language: string; status: string }[]>`
      select org_id, child_id, child_alias, language, status from cases where id = ${appt.case_id}`;
    expect(kase).toMatchObject({ org_id: providerA.orgId, child_id: consented, child_alias: "Anaya (synthetic)", language: "en", status: "booked" });
    const team = await sql<{ user_id: string; care_role: string }[]>`select user_id, care_role from case_assignments where case_id = ${appt.case_id} and removed_at is null`;
    expect(team).toContainEqual({ user_id: providerA.user.id, care_role: "lead" });

    const [attempt, ...more] = await attempts(id);
    expect(more).toEqual([]);
    expect(attempt).toMatchObject({ status: "issued", agent_kind: "child_dev", case_id: appt.case_id });
    expect(attempt.expires_at.toISOString()).toBe(appt.starts_at.toISOString());
    const token = tokenOf(attempt.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(event.payload.intake).toEqual({ status: "link", attempt_id: attempt.id, agent_kind: "child_dev" });

    // FR-3: guardian in-app + email carry the link; the provider's copy does not.
    const notes = await guardianNotes("appointment.confirmed", id);
    expect(notes.map((n) => n.channel)).toEqual(["email", "in_app", "whatsapp"]);
    for (const n of notes) expect(n.body).toContain(`${LINK_TEXT}${APP}/intake/a/${token}`);
    const providerNotes = await sql<{ body: string }[]>`
      select n.body from notifications n join outbox_events e on e.id = n.event_id
      where e.topic = 'appointment.confirmed' and e.payload ->> 'appointment_id' = ${id} and n.recipient_user_id = ${providerA.user.id}`;
    expect(providerNotes.length).toBeGreaterThan(0);
    for (const n of providerNotes) expect(n.body).not.toContain("/intake/a/");
    const { TEMPLATES } = await import("@/lib/notify/templates");
    const rendered = TEMPLATES.appointment_confirmed.render({
      payload: event.payload as never,
      locale: "en",
      role: "guardian",
      appUrl: APP,
      event: { id: event.id, aggregate_type: "appointment", aggregate_id: id },
    });
    expect(rendered.whatsapp).toMatchObject({ name: "appointment_confirmed_intake", params: [`${APP}/family/appointments`, `${APP}/intake/a/${token}`] });

    // Consumer re-run: same case, same attempt, no extra case / assignment / attempt.
    const before = await sql<{ n: number }[]>`select count(*)::int as n from cases where org_id = ${providerA.orgId} and child_id = ${consented}`;
    expect(await caseLink.linkAppointmentCase(sql, id)).toMatchObject({ result: "existing", case_id: appt.case_id, provider_assignment: "existing" });
    expect(await caseLink.prepareAppointmentIntake(sql, id)).toEqual({ status: "link", attempt_id: attempt.id, agent_kind: "child_dev" });
    await sql`update outbox_events set status = 'pending' where id = ${event.id}`;
    await drain([event.id]);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from cases where org_id = ${providerA.orgId} and child_id = ${consented}`)[0].n).toBe(before[0].n);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from case_assignments where case_id = ${appt.case_id} and removed_at is null`)[0].n).toBe(team.length);
    expect(await attempts(id)).toHaveLength(1);

    // Start: language select en/hi/te for Child-Dev (demo: no live call), then the simulated completion.
    const s = await start(token, { language: "te" });
    expect(s).toMatchObject({ status: 200, json: { demo: true } });
    expect((await attempts(id))[0].status).toBe("started");
    const done = await simulate(token);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ received: true, case_id: appt.case_id, brief: true });
    const [rec] = await sql<{ id: string; appointment_id: string; external_id: string; case_id: string }[]>`
      select id, appointment_id, external_id, case_id from recordings where id = ${done.json.recording_id as string}`;
    expect(rec).toMatchObject({ appointment_id: id, case_id: appt.case_id });
    const reports = await sql<{ kind: string; appointment_id: string }[]>`select kind, appointment_id from reports where recording_id = ${rec.id}`;
    expect(reports).toEqual([{ kind: "pre_session_brief", appointment_id: id }]);
    const facts = await sql<{ n: number }[]>`select count(*)::int as n from facts where recording_id = ${rec.id} and instrument = 'CASE_SHEET'`;
    expect(facts[0].n).toBeGreaterThan(0);
    expect((await attempts(id))[0].status).toBe("completed");
    expect((await start(token, { language: "en" })).status).toBe(409);

    // The case Brief tab finds it; the provider agenda shows "completed" with the case.
    const { getIntakeBrief } = await import("@/lib/queries/intake");
    expect((await getIntakeBrief(appt.case_id as string))?.recording.id).toBe(rec.id);
    const { agendaIntakeStatus, listCaseIntakes } = await import("@/lib/intake/attempts");
    expect((await agendaIntakeStatus([id])).get(id)).toEqual({ status: "completed", case_id: appt.case_id, agent_kind: "child_dev" });
    const listed = await listCaseIntakes(appt.case_id as string);
    expect(listed.find((e) => e.appointment_id === id)?.report?.kind).toBe("pre_session_brief");

    // Duplicate webhook for the stored conversation -> duplicate, nothing new.
    const data = processing.demoAppointmentPostCall({ id: attempt.id, agent_kind: "child_dev" }, rec.external_id);
    expect(await webhook(data)).toEqual({ status: 200, json: { received: true, duplicate: true } });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from recordings where appointment_id = ${id}`)[0].n).toBe(1);
  });

  it("E-2 generic: no language choice, one generic_intake_brief checked against the health profile; replay -> duplicate", async () => {
    const id = await book(genericA, consented);
    const event = await drainConfirmation(id);
    const [attempt] = await attempts(id);
    expect(attempt).toMatchObject({ agent_kind: "generic", status: "issued" });
    expect(event.payload.intake).toEqual({ status: "link", attempt_id: attempt.id, agent_kind: "generic" });
    const token = tokenOf(attempt.id);
    expect((await start(token, { language: "te" })).json).toEqual({ demo: true }); // language ignored: English only
    const audit = await sql<{ details: Json }[]>`select details from audit_events where action = 'intake.started' and entity_id = ${attempt.id}`;
    expect(audit[0].details).toMatchObject({ language: "en", agent_kind: "generic" });

    // Webhook from the child-dev agent for a generic attempt -> refused, nothing stored.
    const wrongAgent = processing.demoAppointmentPostCall({ id: attempt.id, agent_kind: "generic" }, `conv-${key()}`);
    expect(await webhook({ ...wrongAgent, agent_id: CHILD_DEV_AGENT })).toEqual({ status: 200, json: { received: true, ignored: "agent mismatch" } });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from recordings where appointment_id = ${id}`)[0].n).toBe(0);

    const conversation = `conv-${key()}`;
    const data = processing.demoAppointmentPostCall({ id: attempt.id, agent_kind: "generic" }, conversation);
    expect(data.agent_id).toBe(GENERIC_AGENT);
    const first = await webhook(data);
    expect(first.json).toMatchObject({ received: true, brief: true });
    const reports = await sql<{ kind: string; content: unknown; content_md: string; appointment_id: string }[]>`
      select kind, content, content_md, appointment_id from reports where appointment_id = ${id}`;
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe("generic_intake_brief");
    const stored = StoredGenericBriefSchema.parse(reports[0].content);
    expect(stored.health_check).toMatchObject({
      recorded: true,
      medications: [{ name: "Paracetamol syrup", match: "not_in_profile" }],
      allergies: [{ substance: "Peanut", match: "in_profile" }],
      profile_only: { medications: ["Iron syrup"], allergies: [] },
    });
    expect(reports[0].content_md).toContain("## Pre-consult brief (parent-reported)");
    expect(await webhook(data)).toEqual({ status: 200, json: { received: true, duplicate: true } });
    expect(await sql`select 1 from reports where appointment_id = ${id}`).toHaveLength(1);
    expect(await sql`select 1 from facts f join recordings r on r.id = f.recording_id where r.appointment_id = ${id}`).toHaveLength(0);

    // The case-level (Child Development) Brief skips generic calls.
    const appt = await appointment(id);
    const { getIntakeBrief } = await import("@/lib/queries/intake");
    const brief = await getIntakeBrief(appt.case_id as string);
    const generic = await sql<{ id: string }[]>`select id from recordings where appointment_id = ${id}`;
    expect(brief?.recording.id).not.toBe(generic[0].id);
  });

  it("E-3 consent: no link without ai_intake_call, the consent hint instead; granting issues the link (notification)", async () => {
    const id = await book(childDevA, notConsented);
    const event = await drainConfirmation(id);
    expect(event.payload.intake).toEqual({ status: "consent_needed", agent_kind: "child_dev" });
    expect(await attempts(id)).toEqual([]);
    const notes = await guardianNotes("appointment.confirmed", id);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.body).toContain(CONSENT_TEXT);
      expect(n.body).not.toContain("/intake/a/");
    }

    await world.grant(notConsented, guardian, linkNotConsented, ["ai_intake_call"]);
    const granted = await sql<{ id: string }[]>`
      select id::text from outbox_events where topic = 'consent.granted' and payload ->> 'child_id' = ${notConsented} and status = 'pending'`;
    expect(granted).toHaveLength(1);
    await drain(granted.map((g) => g.id));
    const [attempt] = await attempts(id);
    expect(attempt).toMatchObject({ status: "issued", agent_kind: "child_dev" });
    const linkEvents = await eventsOf(id, "appointment.intake_link");
    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0].payload.intake_attempt_id).toBe(attempt.id);
    await drain(linkEvents.map((e) => e.id));
    const linkNotes = await guardianNotes("appointment.intake_link", id);
    expect(linkNotes.map((n) => n.channel)).toContain("in_app");
    for (const n of linkNotes) expect(n.body).toContain(`${APP}/intake/a/${tokenOf(attempt.id)}`);
    // Re-running the consumer issues nothing new.
    expect(await caseLink.issueIntakeLinksForChild(sql, notConsented)).toEqual([]);

    // Withdrawal revokes the open link; the page/start answer 410.
    await world.withdraw(notConsented, guardian, linkNotConsented, ["ai_intake_call"]);
    expect((await attempts(id))[0]).toMatchObject({ status: "revoked", revoked_reason: "consent_withdrawn" });
    expect(await start(tokenOf(attempt.id), { language: "en" })).toMatchObject({ status: 410, json: { error: EXPIRED } });
  });

  it("consent is re-checked at start and at completion (guardian link revoked -> consent no longer valid)", async () => {
    const id = await book(childDevA, consented);
    await drainConfirmation(id);
    const [attempt] = await attempts(id);
    const token = tokenOf(attempt.id);
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${linkConsented}`;
    try {
      const s = await start(token, { language: "en" });
      expect(s.status).toBe(422);
      expect(s.json.error).toBe("Guardian consent required");
      const data = processing.demoAppointmentPostCall({ id: attempt.id, agent_kind: "child_dev" }, `conv-${key()}`);
      expect((await webhook(data)).json).toEqual({ received: true, ignored: "consent_withdrawn" });
      expect(await sql`select 1 from recordings where appointment_id = ${id}`).toHaveLength(0);
      expect((await complete(token, `conv-${key()}`)).status).toBe(422);
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where id = ${linkConsented}`;
    }
  });

  it("E-3 cancel revokes the link (410), reschedule moves it (same token, new expiry), expiry at the start", async () => {
    const cancelled = await book(childDevA, consented);
    await drainConfirmation(cancelled);
    const [a1] = await attempts(cancelled);
    as(guardian);
    const c = await call(routes.cancel.POST, post(`http://localhost/api/appointments/${cancelled}/cancel`, {}), { id: cancelled });
    expect(c.status).toBe(200);
    expect((await attempts(cancelled))[0]).toMatchObject({ status: "revoked", revoked_reason: "appointment_cancelled" });
    const t1 = tokenOf(a1.id);
    expect(await start(t1, { language: "en" })).toMatchObject({ status: 410, json: { error: EXPIRED } });
    expect((await simulate(t1)).status).toBe(410);
    expect((await complete(t1, `conv-${key()}`)).status).toBe(410);

    const moved = await book(childDevA, consented);
    await drainConfirmation(moved);
    const [a2] = await attempts(moved);
    const newStart = nextStart();
    as(guardian);
    const r = await call(routes.reschedule.POST, post(`http://localhost/api/appointments/${moved}/reschedule`, { start: newStart.toISOString() }), { id: moved });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const newId = (r.json.appointment as Json).id as string;
    appointmentIds.push(newId);
    expect(await attempts(moved)).toEqual([]);
    const [after] = await attempts(newId);
    expect(after.id).toBe(a2.id);
    expect(after.expires_at.toISOString()).toBe(newStart.toISOString());
    expect((await appointment(newId)).case_id).toBe((await appointment(moved)).case_id);
    const rescheduled = await drainConfirmation(newId, "appointment.rescheduled");
    expect(rescheduled.payload.intake).toEqual({ status: "link", attempt_id: a2.id, agent_kind: "child_dev" });
    expect((await start(tokenOf(a2.id), { language: "hi" })).json).toEqual({ demo: true });

    // Expiry: the link stops at the appointment start.
    await sql`update intake_attempts set expires_at = now() - interval '1 minute' where id = ${a2.id}`;
    expect(await start(tokenOf(a2.id), { language: "en" })).toMatchObject({ status: 410, json: { error: EXPIRED } });
  });

  it("E-4 case reuse in the org, a separate case in another org, and a token cannot complete another appointment", async () => {
    const first = await book(childDevA, consented);
    await drainConfirmation(first);
    const second = await book(genericA, consented);
    await drainConfirmation(second);
    const caseA = (await appointment(first)).case_id;
    expect((await appointment(second)).case_id).toBe(caseA);

    const other = await book(childDevB, consented);
    await drainConfirmation(other);
    const caseB = (await appointment(other)).case_id as string;
    expect(caseB).not.toBe(caseA);
    expect((await sql<{ org_id: string }[]>`select org_id from cases where id = ${caseB}`)[0].org_id).toBe(providerB.orgId);
    // Org A's provider has no access to org B's case (and vice versa).
    const [levels] = await sql<{ a: string | null; b: string | null }[]>`
      select public.case_access_level(${providerA.user.id}, ${caseB}) as a, public.case_access_level(${providerB.user.id}, ${caseA}) as b`;
    expect(levels).toEqual({ a: null, b: null });

    const [x] = await attempts(first);
    const [y] = await attempts(other);
    // A call made for X, reported on Y's link -> refused, nothing attached to Y.
    const callX = processing.demoAppointmentPostCall({ id: x.id, agent_kind: "child_dev" }, `conv-${key()}`);
    await expect(processing.processAppointmentPostCall(callX, { expectedAttemptId: y.id })).rejects.toBeInstanceOf(processing.AttemptMismatchError);
    const storedX = await processing.processAppointmentPostCall(callX);
    expect(storedX).toMatchObject({ received: true, brief: true });
    // X's conversation reported on Y's link: the conversation already belongs to X -> 403, Y untouched.
    const replayOnY = await complete(tokenOf(y.id), callX.conversation_id);
    expect(replayOnY).toEqual({ status: 403, json: { error: "This call does not belong to this intake link" } });
    expect(await sql`select 1 from recordings where appointment_id = ${other}`).toHaveLength(0);
    expect((await attempts(other))[0].status).toBe("issued");
    // Via the webhook the call can only ever attach to the attempt it names (X): a replay is a duplicate of X.
    expect((await webhook(callX)).json).toEqual({ received: true, duplicate: true });
  });

  it("D-4: a new service without intake_kind gets the provider type's default", async () => {
    as(providerA.user);
    const res = await call(
      routes.services.POST,
      post("http://localhost/api/provider/services", { name: "Default intake (synthetic)", mode: "video", duration_min: 30, fee_inr: 0, payment_mode: "free", org_id: providerA.orgId }),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect((res.json.service as Json).intake_kind).toBe("child_dev"); // speech_language_pathologist
  });

  it("the existing case-level intake link keeps working (009/010)", async () => {
    const legacy = await world.kase(providerA.orgId, { childId: consented });
    const { hasIntakeRecording, getCaseByToken } = await import("@/lib/queries/intake");
    expect((await getCaseByToken(legacy.token))?.id).toBe(legacy.caseId);
    expect(await hasIntakeRecording(legacy.caseId)).toBe(false);
    const { POST } = await import("@/app/api/dev/simulate-intake/[token]/route");
    const res = await call(POST, post(`http://localhost/api/dev/simulate-intake/${legacy.token}`), { token: legacy.token });
    expect(res.json).toMatchObject({ received: true, case_id: legacy.caseId, brief: true });
    expect(await hasIntakeRecording(legacy.caseId)).toBe(true);
  });
});
