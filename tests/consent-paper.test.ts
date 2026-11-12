// Ticket 020 FR-18a-e: paper consent recorded by the centre (E-5a). Counts like digital consent for every
// gate, strict audit, scan only via signed URL for the case's org, withdrawal on paper or by the guardian.
// Local Supabase stack only (DATABASE_URL); synthetic data and a synthetic one-page "scan".
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const PDF = new TextEncoder().encode("%PDF-1.4\n% synthetic signed consent form (test)\n%%EOF\n");

function todayIst(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

describe.skipIf(!enabled)("paper consent recorded by the centre (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let providerA: TestUser, providerB: TestUser, guardian: TestUser;
  let orgA: string, orgB: string;
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  async function docIds(features: string[], locale = "en") {
    const rows = await sql<{ id: string; feature: string }[]>`
      select distinct on (feature) id, feature from consent_documents where locale = ${locale} and feature in ${sql(features)}
      order by feature, version desc`;
    return rows.map((r) => r.id);
  }

  async function form(over: Partial<Record<string, string | null>> = {}, features = ["ai_transcription"], scan: Uint8Array<ArrayBuffer> | null = PDF) {
    const f = new FormData();
    for (const x of features) f.append("features[]", x);
    for (const id of over.docs === undefined ? await docIds(features) : over.docs ? [over.docs] : []) f.append("consent_document_ids[]", id);
    const fields: Record<string, string | null> = {
      guardian_name: "Lakshmi (synthetic)",
      relationship: "mother",
      signed_on: todayIst(),
      attestation: "true",
      ...over,
    };
    delete fields.docs;
    for (const [k, v] of Object.entries(fields)) if (v !== null) f.append(k, v);
    if (scan) f.append("scan", new File([scan], "signed.pdf", { type: "application/pdf" }));
    return f;
  }

  async function record(caseId: string, body: FormData) {
    const { POST } = await import("@/app/api/cases/[id]/paper-consents/route");
    return POST(new Request("http://localhost/x", { method: "POST", body }), ctx({ id: caseId }));
  }

  const counts = async (childId: string) => {
    const [r] = await sql<{ n: number }[]>`select count(*)::int as n from consent_records where child_id = ${childId}`;
    const objs = await db.storage.from("consent-forms").list(childId);
    return { records: r.n, scans: (objs.data ?? []).length };
  };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t020p");
    providerA = await world.user("provider-a", "provider");
    providerB = await world.user("provider-b", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    orgA = await world.org(providerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
  });

  afterAll(async () => {
    const childIds = (await sql<{ id: string }[]>`select id from children where display_name like 't020p%'`).map((r) => r.id);
    for (const id of childIds) {
      const objs = await db.storage.from("consent-forms").list(id);
      const keys = (objs.data ?? []).map((o) => `${id}/${o.name}`);
      if (keys.length) await db.storage.from("consent-forms").remove(keys);
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(providerA));

  it("E-5a.2 / FR-18e: paper consent for ai_transcription on a legacy case unblocks only that gate", async () => {
    const c = await world.kase(orgA);
    await sql`update children set source = 'legacy_case' where id = ${c.childId}`;
    const res = await record(c.caseId, await form());
    expect(res.status).toBe(201);
    const { state } = (await res.json()) as { state: Record<string, { granted: boolean; method: string }> };
    expect(state.ai_transcription).toMatchObject({ granted: true, method: "paper" });
    expect(state.ai_extraction.granted).toBe(false);

    const { requireCaseConsent } = await import("@/lib/consent");
    expect(await requireCaseConsent(c.caseId, "ai_transcription")).toBeNull();
    // The already-processed legacy session passes the transcription gate (no audio here -> 409, not 422).
    const { POST: transcribe } = await import("@/app/api/sessions/[id]/transcribe/route");
    const tr = await transcribe(post("http://localhost/x"), ctx({ id: c.recordingId }));
    expect(tr.status).toBe(409);
    expect(await tr.json()).toEqual({ error: "Audio file not uploaded yet" });
    const blocked = await requireCaseConsent(c.caseId, "ai_extraction");
    expect(blocked?.status).toBe(422);
    expect(await blocked?.json()).toEqual({
      error: "Guardian consent required",
      details: { feature: "ai_extraction", child_id: c.childId },
    });

    const [row] = await sql`
      select method, attested_by, paper_guardian_name, paper_relationship, paper_signed_on::text as signed, paper_form_path,
             guardian_user_id, guardian_link_id, case_id
      from consent_records where child_id = ${c.childId}`;
    expect(row).toMatchObject({
      method: "paper",
      attested_by: providerA.id,
      paper_guardian_name: "Lakshmi (synthetic)",
      paper_relationship: "mother",
      signed: todayIst(),
      guardian_user_id: null,
      guardian_link_id: null,
      case_id: c.caseId,
    });
    expect(row.paper_form_path).toMatch(new RegExp(`^${c.childId}/[0-9a-f-]+\\.pdf$`));
    expect((await counts(c.childId)).scans).toBe(1);
    const [audit] = await sql`select actor, actor_user_id from audit_events where case_id = ${c.caseId} and action = 'consent.paper_recorded'`;
    expect(audit).toEqual({ actor: "therapist", actor_user_id: providerA.id });

    // Panel text source: the provider who attested, on this case.
    const { getConsentState } = await import("@/lib/consent");
    const s = (await getConsentState(c.childId)).ai_transcription;
    expect(s).toMatchObject({ method: "paper", attested_by: providerA.id, case_id: c.caseId });
  });

  it("E-5a.3: missing scan / attestation / future date -> 400, outdated text -> 409; nothing written", async () => {
    const c = await world.kase(orgA);
    const cases: [string, FormData, number][] = [
      ["missing scan", await form({}, ["ai_transcription"], null), 400],
      ["missing attestation", await form({ attestation: null }), 400],
      ["future signed_on", await form({ signed_on: todayIst(2) }), 400],
      ["not a PDF/JPEG/PNG", await form({}, ["ai_transcription"], new TextEncoder().encode("hello")), 400],
    ];
    for (const [name, body, status] of cases) {
      const res = await record(c.caseId, body);
      expect(res.status, name).toBe(status);
    }
    const [v2] = await sql<{ id: string }[]>`
      insert into consent_documents (feature, version, locale, title, body_md, processors)
      values ('ai_extraction', 2, 'te', 't020 v2 (synthetic)', 'synthetic', '[]') returning id`;
    try {
      const [v1te] = await sql<{ id: string }[]>`select id from consent_documents where feature = 'ai_extraction' and locale = 'te' and version = 1`;
      const res = await record(c.caseId, await form({ docs: v1te.id }, ["ai_extraction"]));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Please review the updated text" });
    } finally {
      await sql`delete from consent_documents where id = ${v2.id}`;
    }
    expect(await counts(c.childId)).toEqual({ records: 0, scans: 0 });
  });

  it("E-5a.3: a forced audit failure -> 503 and nothing kept (no record, scan removed)", async () => {
    const c = await world.kase(orgA);
    const fn = `t020_fail_paper_${c.childId.slice(0, 8)}`;
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin raise exception 'forced audit failure (test)'; end $f$;
      create trigger ${fn} before insert on public.audit_events for each row
      when (new.action = 'consent.paper_recorded' and new.entity_id = '${c.childId}') execute function public.${fn}();`);
    try {
      const res = await record(c.caseId, await form());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Could not save. Please try again." });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    }
    expect(await counts(c.childId)).toEqual({ records: 0, scans: 0 });
  });

  it("E-5a.4: other orgs get 404 on both endpoints; the scan is only a signed URL for the case's org", async () => {
    const c = await world.kase(orgA);
    const res = await record(c.caseId, await form());
    expect(res.status).toBe(201);
    const [rec] = await sql<{ id: string }[]>`select id from consent_records where child_id = ${c.childId}`;

    as(providerB);
    expect((await record(c.caseId, await form())).status).toBe(404);
    const { POST: withdraw } = await import("@/app/api/cases/[id]/paper-consents/withdraw/route");
    expect((await withdraw(post("http://localhost/x", { feature: "ai_transcription", guardian_name: "X" }), ctx({ id: c.caseId }))).status).toBe(404);
    const { GET: scan } = await import("@/app/api/cases/[id]/paper-consents/[recordId]/scan/route");
    expect((await scan(post("http://localhost/x", undefined, "GET"), ctx({ id: c.caseId, recordId: rec.id }))).status).toBe(404);
    // Another org's own case id cannot be used to reach this record either.
    const other = await world.kase(orgB);
    expect((await scan(post("http://localhost/x", undefined, "GET"), ctx({ id: other.caseId, recordId: rec.id }))).status).toBe(404);

    as(guardian);
    expect((await scan(post("http://localhost/x", undefined, "GET"), ctx({ id: c.caseId, recordId: rec.id }))).status).toBe(403);

    as(providerA);
    const ok = await scan(post("http://localhost/x", undefined, "GET"), ctx({ id: c.caseId, recordId: rec.id }));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toMatch(/\/storage\/v1\/object\/sign\/consent-forms\/.+token=/);
    const pub = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/consent-forms/${c.childId}/x.pdf`);
    expect(pub.ok).toBe(false);
  });

  it("E-5a.5: a paper withdrawal blocks the gate again and queued work for that feature aborts", async () => {
    const c = await world.kase(orgA);
    expect((await record(c.caseId, await form())).status).toBe(201);
    const { POST: withdraw } = await import("@/app/api/cases/[id]/paper-consents/withdraw/route");
    const res = await withdraw(
      post("http://localhost/x", { feature: "ai_transcription", guardian_name: "Lakshmi (synthetic)", note: "Told the front desk" }),
      ctx({ id: c.caseId }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: Record<string, { granted: boolean }> }).state.ai_transcription.granted).toBe(false);
    const { assertConsentOrAbort, requireCaseConsent } = await import("@/lib/consent");
    expect((await requireCaseConsent(c.caseId, "ai_transcription"))?.status).toBe(422);
    const proceed = await assertConsentOrAbort(c.childId, "ai_transcription", {
      stage: "before_scribe",
      caseId: c.caseId,
      recordingId: c.recordingId,
      markRecordingFailed: true,
    });
    expect(proceed).toBe(false);
    const [rec] = await sql`select status, error from recordings where id = ${c.recordingId}`;
    expect(rec).toEqual({ status: "failed", error: "consent_withdrawn" });
    const [w] = await sql`select method, paper_note, paper_form_path from consent_records where child_id = ${c.childId} and action = 'withdrawn'`;
    expect(w).toEqual({ method: "paper", paper_note: "Told the front desk", paper_form_path: null });
  });

  it("E-5a.6 / FR-18d: after a guardian claims the child they see the paper consent and can withdraw it digitally", async () => {
    const c = await world.kase(orgA);
    expect((await record(c.caseId, await form({}, ["ai_transcription", "ai_extraction"]))).status).toBe(201);
    const { POST: code } = await import("@/app/api/cases/[id]/claim-code/route");
    const created = (await (await code(post("http://localhost/x"), ctx({ id: c.caseId }))).json()) as { code: string };
    as(guardian);
    const { POST: claims } = await import("@/app/api/family/claims/route");
    expect((await claims(post("http://localhost/x", { code: created.code, relationship: "mother", declaration: true }))).status).toBe(201);

    const consents = await import("@/app/api/family/children/[id]/consents/route");
    const state = ((await (await consents.GET(post("http://localhost/x"), ctx({ id: c.childId }))).json()) as {
      state: Record<string, { granted: boolean; method: string; paper_signed_on: string }>;
    }).state;
    expect(state.ai_transcription).toMatchObject({ granted: true, method: "paper", paper_signed_on: todayIst() });

    const { POST: withdraw } = await import("@/app/api/family/children/[id]/consents/[feature]/withdraw/route");
    expect((await withdraw(post("http://localhost/x"), ctx({ id: c.childId, feature: "ai_transcription" }))).status).toBe(200);
    const { requireCaseConsent } = await import("@/lib/consent");
    expect((await requireCaseConsent(c.caseId, "ai_transcription"))?.status).toBe(422);
    expect(await requireCaseConsent(c.caseId, "ai_extraction")).toBeNull();
  });
});
