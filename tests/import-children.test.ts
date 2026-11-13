// Ticket 047: import existing children from a CSV. Pure checks (CSV reader, dates, phones, timetable columns, row
// messages) always run; the routes run against the local Supabase stack (DATABASE_URL): preview, import, duplicates,
// idempotency, no consent and no outbox messages, therapist assignments, claim codes, undo, roles, 500 rows < 30 s
// and the timetable fallback. 044 extra scope: the import creates real 043 series (billing_mode column), undo removes
// the import's untouched series and their future sessions (and refuses touched ones), and pending timetables of earlier
// imports are scheduled once (button route + script function). Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeUtf8, parseCsv, toCsv } from "@/lib/import/csv";
import { parseTime, parseWeekdays } from "@/lib/import/timetable";
import { parseDateOfBirth, parseImportText, validateRows, type ValidationContext } from "@/lib/import/validate";
import { createWorld, ctx, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "import");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    today: "2026-11-13",
    members: new Map([
      ["therapist.a@clinic.example", { user_id: "00000000-0000-4000-8000-0000000000a1", name: "Therapist A" }],
      ["therapist.b@clinic.example", { user_id: "00000000-0000-4000-8000-0000000000b1", name: "Therapist B" }],
    ]),
    services: [{ id: "00000000-0000-4000-8000-0000000000c1", name: "Speech therapy (synthetic)", provider_user_id: "00000000-0000-4000-8000-0000000000a1" }],
    existing: [],
    seriesAvailable: false,
    ...overrides,
  };
}

const validate = (text: string, overrides: Partial<ValidationContext> = {}) => validateRows(parseImportText(text), context(overrides));

describe("CSV reader (FR-1)", () => {
  it("handles quotes, embedded commas/newlines, CRLF, a BOM and the ; delimiter", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi""\nbye"\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"\nbye'],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(decodeUtf8(new TextEncoder().encode("\uFEFFchild_first_name"))).toBe("child_first_name");
  });

  it("accepts UTF-8 Telugu/Hindi names and refuses other encodings", () => {
    const bytes = readFileSync(path.join(FIXTURES, "telugu-names.csv"));
    expect(decodeUtf8(bytes)).toContain("శ్రీజ");
    expect(decodeUtf8(Uint8Array.from([0x41, 0xe9, 0x42]))).toBeNull(); // Latin-1 "AéB"
  });

  it("downloaded lists neutralise spreadsheet formulas but keep phone numbers", () => {
    expect(toCsv([["=HYPERLINK(1)", "+91 90000 00001", "-x", "plain"]])).toBe("'=HYPERLINK(1),+91 90000 00001,'-x,plain");
  });
});

describe("dates, timetable and per-row validation (FR-1, FR-2)", () => {
  it("parses both date formats (and refuses impossible dates)", () => {
    expect(parseDateOfBirth("2021-03-14")).toBe("2021-03-14");
    expect(parseDateOfBirth("14/03/2021")).toBe("2021-03-14");
    expect(parseDateOfBirth("3/4/2020")).toBe("2020-04-03");
    expect(parseDateOfBirth("27-09-2022")).toBe("2022-09-27");
    expect(parseDateOfBirth("31/02/2021")).toBeNull();
    expect(parseDateOfBirth("2021/03/14")).toBeNull();
    expect(parseDateOfBirth("March 3")).toBeNull();
  });

  it("parses weekdays and times", () => {
    expect(parseWeekdays("Mon;Wed;Fri")).toEqual([1, 3, 5]);
    expect(parseWeekdays("tuesday, thu")).toEqual([2, 4]);
    expect(parseWeekdays("Mon;Funday")).toBeNull();
    expect(parseWeekdays("Mon;Tue;Wed;Thu;Fri")).toBeNull(); // at most 4 days (043)
    expect(parseTime("10:00")).toBe("10:00");
    expect(parseTime("4:30 pm")).toBe("16:30");
    expect(parseTime("10am")).toBe("10:00");
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("10")).toBeNull();
  });

  it("valid-20.csv: 20 valid rows with both date formats, phones normalised, languages mapped", () => {
    const rows = validate(fixture("valid-20.csv"));
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.status === "valid")).toHaveLength(20);
    expect(rows[0]).toMatchObject({ row: 2, date_of_birth: "2021-03-14", guardian_phone: "+919000000101", language: "te" });
    expect(rows[1]).toMatchObject({ date_of_birth: "2020-07-05", guardian_phone: "+919000000102", language: "hi" });
    expect(rows[2].notes).toBe("OT, sensory diet");
    expect(rows[10].language).toBe("en"); // "english"
  });

  it("errors.csv: every message names its spreadsheet row; ages above 8 are a warning only", () => {
    const rows = validate(fixture("errors.csv"));
    const byRow = new Map(rows.map((r) => [r.row, r]));
    const codes = (row: number) => byRow.get(row)!.errors.map((e) => e.code);
    expect(codes(3)).toEqual(["dob_future"]);
    expect(byRow.get(3)!.errors[0].message).toBe("Row 3: date of birth is in the future");
    expect(codes(4)).toEqual(["therapist_unknown"]);
    expect(byRow.get(4)!.errors[0].message).toBe("Row 4: no therapist with this email in your organisation");
    expect(codes(5)).toEqual(["phone_invalid"]);
    expect(codes(7)).toEqual(["name_required"]);
    expect(codes(8)).toEqual(["dob_invalid"]);
    expect(codes(10)).toEqual(["language_invalid"]);
    expect(byRow.get(9)!.status).toBe("valid");
    expect(byRow.get(9)!.warnings.map((w) => w.code)).toEqual(["age_over_8"]);
    for (const r of rows) for (const e of [...r.errors, ...r.warnings]) expect(e.message).toMatch(new RegExp(`^Row ${r.row}: `));
    expect(rows.filter((r) => r.status === "valid").map((r) => r.row)).toEqual([2, 6, 9]);
  });

  it("18 or older is refused", () => {
    const [row] = validate("child_first_name,date_of_birth,guardian_name\nAdult,2000-01-01,P\n");
    expect(row.errors.map((e) => e.code)).toEqual(["dob_too_old"]);
  });

  it("duplicates: same first name + DOB + phone against the org and within the file", () => {
    const rows = validate(fixture("dupes.csv"), {
      existing: [
        { case_id: "c1", display_name: "Aarav Reddy (synthetic)", date_of_birth: "2021-03-14", phone: "+919000000101" },
        { case_id: "c2", display_name: "Diya Sharma (synthetic)", date_of_birth: "2020-07-05", phone: "+91 90000 00102" },
        { case_id: "c3", display_name: "Jai Other", date_of_birth: "2021-09-09", phone: "+919999999999" },
      ],
    });
    expect(rows.map((r) => r.status)).toEqual(["duplicate", "duplicate", "valid", "duplicate"]);
    expect(rows[0].duplicate_of).toEqual({ kind: "existing", case_id: "c1" });
    expect(rows[1].duplicate_of).toEqual({ kind: "existing", case_id: "c2" });
    expect(rows[3].duplicate_of).toEqual({ kind: "file", row: 4 });
    expect(rows[3].warnings[0].message).toBe("Row 5: same child as row 4 of this file");
  });

  it("timetable columns are validated; without 043 a valid timetable is kept as pending", () => {
    const rows = validate(fixture("timetable.csv"));
    expect(rows.map((r) => r.errors.map((e) => e.code))).toEqual([[], ["weekdays_invalid"], ["service_unknown"], ["timetable_needs_therapist"], []]);
    expect(rows[0].timetable).toMatchObject({ weekdays: [1, 3, 5], time: "10:00", service_name: "Speech therapy (synthetic)" });
    expect(rows[0].warnings.map((w) => w.code)).toContain("timetable_pending");
    expect(validate(fixture("timetable.csv"), { seriesAvailable: true })[0].warnings.map((w) => w.code)).not.toContain("timetable_pending");
  });

  it("file-level problems: missing columns, too many rows, unclosed quote", () => {
    expect(parseImportText("name,dob\nA,2021-01-01").fileErrors.map((e) => e.code)).toEqual(["missing_columns"]);
    const big = ["child_first_name,date_of_birth,guardian_name", ...Array.from({ length: 501 }, (_, i) => `C${i},2021-01-01,P`)].join("\n");
    expect(parseImportText(big).fileErrors.map((e) => e.code)).toEqual(["too_many_rows"]);
    expect(parseImportText('child_first_name,date_of_birth,guardian_name\n"A,2021-01-01,P').fileErrors[0].code).toBe("csv_syntax");
  });
});

describe.skipIf(!enabled)("import routes (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let owner: TestUser, admin: TestUser, therapistA: TestUser, therapistB: TestUser, member: TestUser, outsider: TestUser;
  let guardian: TestUser;
  let orgId: string, otherOrg: string, profileA: string, profileB: string;
  const childIds = new Set<string>();
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    preview: await import("@/app/api/org/import/preview/route"),
    run: await import("@/app/api/org/import/route"),
    detail: await import("@/app/api/org/import/[id]/route"),
    undo: await import("@/app/api/org/import/[id]/undo/route"),
    codes: await import("@/app/api/org/import/[id]/codes/route"),
    template: await import("@/app/api/org/import/template/route"),
    claims: await import("@/app/api/family/claims/route"),
  });

  /** Fixture text with the placeholder therapist emails swapped for the suite's real members. */
  const withMembers = (text: string) =>
    text.replaceAll("therapist.a@clinic.example", therapistA.email).replaceAll("therapist.b@clinic.example", therapistB.email);

  function upload(url: string, text: string, opts: { org?: string; importDuplicates?: number[] } = {}) {
    const form = new FormData();
    form.set("org_id", opts.org ?? orgId);
    form.set("file", new File([text], "children.csv", { type: "text/csv" }));
    if (opts.importDuplicates) form.set("import_duplicates", JSON.stringify(opts.importDuplicates));
    return new Request(url, { method: "POST", body: form });
  }

  async function previewAs(user: TestUser, text: string, opts: { org?: string } = {}) {
    as(user);
    return (await routes()).preview.POST(upload("http://localhost/api/org/import/preview", text, opts));
  }

  type ImportJson = {
    result: string;
    import: { id: string; imported_count: number; skipped_count: number; failed_count: number; timetable_pending_count: number };
    items: { row: number; case_id: string; child_id: string; code: string; whatsapp_url: string; message: string; paper_consent_path: string }[];
    skipped: number[];
  };

  async function importAs(user: TestUser, text: string, opts: { org?: string; importDuplicates?: number[] } = {}) {
    as(user);
    const res = await (await routes()).run.POST(upload("http://localhost/api/org/import", text, opts));
    if (res.status === 201) for (const item of ((await res.clone().json()) as ImportJson).items) childIds.add(item.child_id);
    return res;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t047");
    owner = await world.user("owner", "provider");
    admin = await world.user("admin", "provider");
    therapistA = await world.user("ther-a", "provider");
    therapistB = await world.user("ther-b", "provider");
    member = await world.user("member", "provider");
    outsider = await world.user("outsider", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    orgId = await world.org(owner, "Centre");
    otherOrg = await world.org(outsider, "Other centre");
    await sql`insert into org_members (org_id, user_id, org_role) values (${orgId}, ${admin.id}, 'admin')`;
    for (const u of [therapistA, therapistB, member]) await world.member(orgId, u);
    const [profile] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, is_synthetic)
      values (${therapistA.id}, ${`t047-ther-a-${world.tag}`}, 'Therapist A (synthetic)', 'speech_language_pathologist', true)
      returning id`;
    profileA = profile.id;
    await sql`
      insert into services (provider_profile_id, org_id, name, mode, duration_min, fee_inr, payment_mode)
      values (${profileA}, ${orgId}, 'Speech therapy (synthetic)', 'video', 45, 0, 'free')`;
    // 044: therapist B has a real (not demo) profile, a clinic open all week and an in-clinic service, so the import
    // can create 043 weekly series for B's timetables.
    const [loc] = await sql<{ id: string }[]>`
      insert into practice_locations (org_id, name, address_line1, locality, pincode, lat, lng)
      values (${orgId}, 'Centre (synthetic)', 'Road 2 (synthetic)', 'Kukatpally', '500072', 17.49, 78.40) returning id`;
    const [pb] = await sql<{ id: string }[]>`
      insert into provider_profiles (user_id, slug, display_name, provider_type, verification_status, verified_at, listed, claimed, is_synthetic)
      values (${therapistB.id}, ${`t047-ther-b-${world.tag}`}, 'Therapist B (synthetic)', 'occupational_therapist', 'verified', now(), true, true, false)
      returning id`;
    profileB = pb.id;
    await sql`insert into provider_locations (provider_profile_id, location_id, org_id) values (${profileB}, ${loc.id}, ${orgId})`;
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await sql`
        insert into availability_rules (provider_profile_id, org_id, location_id, weekday, start_time, end_time, mode, valid_from)
        values (${profileB}, ${orgId}, ${loc.id}, ${weekday}, '00:00', '24:00', 'both', current_date - 2)`;
    }
    await sql`
      insert into services (provider_profile_id, org_id, location_id, name, mode, duration_min, fee_inr, payment_mode)
      values (${profileB}, ${orgId}, ${loc.id}, 'OT in clinic (synthetic)', 'in_clinic', 45, 700, 'at_clinic')`;
  });

  afterAll(async () => {
    if (sql) {
      const orgs = [orgId, otherOrg].filter(Boolean);
      if (orgs.length) {
        const rows = await sql<{ child_id: string }[]>`select child_id from cases where org_id in ${sql(orgs)}`;
        for (const r of rows) childIds.add(r.child_id);
        const ids = [...childIds];
        if (ids.length) await sql`delete from outbox_events where payload ->> 'child_id' in ${sql(ids)}`;
      }
      for (const id of childIds) world?.trackChild(id);
      if (profileA) {
        await sql`delete from services where provider_profile_id = ${profileA}`;
        await sql`delete from provider_profiles where id = ${profileA}`;
      }
      if (profileB) {
        const series = (await sql<{ id: string }[]>`select id from appointment_series where provider_profile_id = ${profileB}`).map((r) => r.id);
        const appts = (await sql<{ id: string }[]>`select id from appointments where provider_profile_id = ${profileB}`).map((r) => r.id);
        if (series.length) await sql`delete from outbox_events where aggregate_type = 'appointment_series' and aggregate_id in ${sql(series)}`;
        if (appts.length) await sql`delete from outbox_events where aggregate_type in ('appointment', 'meet') and aggregate_id in ${sql(appts)}`;
        await sql`delete from appointments where provider_profile_id = ${profileB}`;
        await sql`delete from appointment_series where provider_profile_id = ${profileB}`;
        await sql`delete from services where provider_profile_id = ${profileB}`;
        await sql`delete from provider_profiles where id = ${profileB}`;
      }
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  it("template: header row with the FR-1 columns", async () => {
    as(member);
    const res = await (await routes()).template.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.replace(/^\uFEFF/, "").trim()).toBe(
      "child_first_name,child_last_name,date_of_birth,guardian_name,guardian_phone,preferred_language,therapist_email,notes,weekdays,time,service_name,billing_mode",
    );
  });

  it("E-1: valid-20.csv previews 20 valid rows; import creates 20 children, cases, assignments and codes, no consent, no messages", async () => {
    const text = withMembers(fixture("valid-20.csv"));
    const preview = await previewAs(owner, text);
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { summary: { total: number; valid: number }; rows: { status: string }[]; file_hash: string };
    expect(p.summary).toMatchObject({ total: 20, valid: 20 });
    expect(await sql`select 1 from child_imports where file_hash = ${p.file_hash}`).toHaveLength(0); // preview stores nothing

    const startedAt = new Date();
    const res = await importAs(owner, text);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson;
    expect(body.import).toMatchObject({ imported_count: 20, skipped_count: 0, failed_count: 0 });
    expect(body.items).toHaveLength(20);
    for (const item of body.items) {
      expect(item.code).toMatch(CODE);
      expect(item.whatsapp_url).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
      expect(decodeURIComponent(item.whatsapp_url)).toContain(item.code);
      expect(item.message).toContain("/family/children/claim");
      expect(item.paper_consent_path).toBe(`/cases/${item.case_id}/consent/paper`);
    }

    const caseIds = body.items.map((i) => i.case_id);
    const kids = body.items.map((i) => i.child_id);
    const cases = await sql<{ child_alias: string; parent_alias: string; parent_phone: string; language: string; org_id: string; therapist_name: string }[]>`
      select child_alias, parent_alias, parent_phone, language, org_id, therapist_name from cases where id in ${sql(caseIds)} order by created_at`;
    expect(cases).toHaveLength(20);
    expect(cases.every((c) => c.org_id === orgId)).toBe(true);
    expect(cases.map((c) => c.child_alias)).toContain("Aarav Reddy (synthetic)");
    const children = await sql<{ source: string; date_of_birth: string }[]>`
      select source, date_of_birth::text from children where id in ${sql(kids)}`;
    expect(children).toHaveLength(20);
    expect(children.every((c) => c.source === "provider")).toBe(true);

    // Therapist A is the only (lead) assignment of row 2; row 7 (no therapist) has the importing owner as lead.
    const row2 = body.items.find((i) => i.row === 2)!;
    const team2 = await sql`select user_id, care_role from case_assignments where case_id = ${row2.case_id} and removed_at is null`;
    expect(team2).toEqual([{ user_id: therapistA.id, care_role: "lead" }]);
    const row7 = body.items.find((i) => i.row === 7)!;
    expect(await sql`select user_id, care_role from case_assignments where case_id = ${row7.case_id} and removed_at is null`).toEqual([
      { user_id: owner.id, care_role: "lead" },
    ]);
    // The assigned therapist can open the case; the unassigned member cannot.
    const { getCaseAccessLevel } = await import("@/lib/authz");
    expect(await getCaseAccessLevel(therapistA.id, row2.case_id)).toBe("assigned");
    expect(await getCaseAccessLevel(member.id, row2.case_id)).toBeNull();

    // Codes: hash only, 72 h.
    const codes = await sql<{ code_hash: string; expires_at: Date }[]>`
      select code_hash, expires_at from child_claim_codes where case_id in ${sql(caseIds)} and used_at is null`;
    expect(codes).toHaveLength(20);
    const { hashClaimCode, normalizeClaimCode } = await import("@/lib/children/codes");
    expect(codes.map((c) => c.code_hash)).toContain(hashClaimCode(normalizeClaimCode(row2.code) as string));
    const hours = (codes[0].expires_at.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);

    // D-1: no consent records; NFR-2: nothing queued for families.
    expect(await sql`select 1 from consent_records where child_id in ${sql(kids)}`).toHaveLength(0);
    const { getConsentState } = await import("@/lib/consent");
    expect(Object.values(await getConsentState(row2.child_id)).every((s) => !s.granted && s.action === null)).toBe(true);
    const outbox = await sql`
      select 1 from outbox_events where created_at >= ${startedAt}
        and (payload ->> 'child_id' in ${sql(kids)} or payload ->> 'case_id' in ${sql(caseIds)} or aggregate_id in ${sql([...caseIds, ...kids])})`;
    expect(outbox).toHaveLength(0);

    // FR-3 audit: counts only (no names, phones or notes).
    const audits = await sql<{ details: Record<string, unknown>; actor_user_id: string; org_id: string }[]>`
      select details, actor_user_id, org_id from audit_events where action = 'children.imported' and entity_id = ${body.import.id}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: owner.id, org_id: orgId });
    expect(Object.keys(audits[0].details).sort()).toEqual(
      ["failed", "import_id", "imported", "series_created", "skipped", "timetable_pending", "total_rows"].sort(),
    );
    expect(JSON.stringify(audits[0].details)).not.toMatch(/Aarav|Kavya|9000000101|Speech/);

    // NFR-1: only the hash and counts of the file are kept.
    const [stored] = await sql`select file_hash, total_rows from child_imports where id = ${body.import.id}`;
    expect(stored).toEqual({ file_hash: p.file_hash, total_rows: 20 });

    // Re-uploading the same file is idempotent: same import, no new rows.
    const again = await importAs(admin, text);
    expect(again.status).toBe(200);
    expect(((await again.json()) as ImportJson)).toMatchObject({ result: "existing", import: { id: body.import.id } });
    expect(await sql`select 1 from cases where org_id = ${orgId}`).toHaveLength(20);
    const repeatPreview = (await (await previewAs(owner, text)).json()) as { already_imported: { id: string } | null };
    expect(repeatPreview.already_imported?.id).toBe(body.import.id);

    // The 020 claim flow works with an imported code; the import page then shows the family as linked.
    as(guardian);
    const claim = await (await routes()).claims.POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: row2.code, relationship: "mother", declaration: true }),
      }),
    );
    expect(claim.status).toBe(201);
    as(owner);
    const detail = (await (await (await routes()).detail.GET(new Request("http://localhost/x"), ctx({ id: body.import.id }))).json()) as {
      children: { row: number; guardian_linked: boolean; consent_given: boolean }[];
    };
    expect(detail.children).toHaveLength(20);
    expect(detail.children.find((c) => c.row === 2)).toMatchObject({ guardian_linked: true, consent_given: false });

    // Undo is refused now that a guardian claimed row 2.
    const undo = await (await routes()).undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: body.import.id }));
    expect(undo.status).toBe(409);
    expect(((await undo.json()) as { details: { blocked_rows: number[] } }).details.blocked_rows).toEqual([2]);

    // New codes for the 19 unclaimed children; older codes stop working.
    const regen = await (await routes()).codes.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: body.import.id }));
    expect(regen.status).toBe(201);
    const fresh = ((await regen.json()) as { items: { case_id: string; code: string }[] }).items;
    expect(fresh).toHaveLength(19);
    expect(fresh.map((i) => i.case_id)).not.toContain(row2.case_id);
    const live = await sql`select 1 from child_claim_codes where case_id in ${sql(caseIds)} and used_at is null and expires_at > now()`;
    expect(live).toHaveLength(19);
  });

  it("E-2: errors.csv shows a plain message per bad row; import creates only the valid rows", async () => {
    const text = withMembers(fixture("errors.csv"));
    const preview = (await (await previewAs(admin, text)).json()) as {
      summary: { valid: number; errors: number };
      rows: { row: number; status: string; errors: { message: string }[] }[];
    };
    expect(preview.summary).toMatchObject({ valid: 3, errors: 6 });
    for (const r of preview.rows.filter((x) => x.status === "error")) {
      expect(r.errors.length).toBeGreaterThan(0);
      for (const e of r.errors) expect(e.message.startsWith(`Row ${r.row}: `)).toBe(true);
    }
    expect(preview.rows.find((r) => r.row === 3)!.errors[0].message).toBe("Row 3: date of birth is in the future");

    const res = await importAs(admin, text);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson & { failed: { row: number }[] };
    expect(body.import).toMatchObject({ imported_count: 3, failed_count: 6, skipped_count: 0 });
    expect(body.items.map((i) => i.row)).toEqual([2, 6, 9]);
    expect(body.failed.map((f) => f.row)).toEqual([3, 4, 5, 7, 8, 10]);
  });

  it("Telugu and Hindi names are kept exactly", async () => {
    const res = await importAs(owner, withMembers(fixture("telugu-names.csv")));
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson;
    const names = await sql<{ display_name: string }[]>`select display_name from children where id in ${sql(body.items.map((i) => i.child_id))}`;
    expect(names.map((n) => n.display_name).sort()).toEqual(["ఆరవ్ నాయుడు", "శ్రీజ రెడ్డి", "अनन्या शर्मा"].sort());
    const notes = await sql<{ notes: string | null }[]>`select notes from child_import_rows where import_id = ${body.import.id} order by row_number`;
    expect(notes[0].notes).toBe("మాటలు ఆలస్యం (synthetic)");
  });

  it("duplicates are flagged; Skip by default, `Import anyway` per row", async () => {
    const text = withMembers(fixture("dupes.csv"));
    const preview = (await (await previewAs(owner, text)).json()) as { rows: { row: number; status: string; duplicate_of: unknown }[] };
    expect(preview.rows.map((r) => r.status)).toEqual(["duplicate", "duplicate", "valid", "duplicate"]);
    expect(preview.rows[0].duplicate_of).toMatchObject({ kind: "existing" });
    expect(preview.rows[3].duplicate_of).toEqual({ kind: "file", row: 4 });

    const res = await importAs(owner, text, { importDuplicates: [3] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson;
    expect(body.items.map((i) => i.row).sort()).toEqual([3, 4]);
    expect(body.skipped.sort()).toEqual([2, 5]);
    expect(body.import).toMatchObject({ imported_count: 2, skipped_count: 2, failed_count: 0 });
  });

  it("undo within 24 h deletes the import's children, cases and codes; refused once a session note exists or after 24 h", async () => {
    const csv = (tag: string) =>
      `child_first_name,date_of_birth,guardian_name,guardian_phone,therapist_email\nUndo${tag},2021-01-0${tag},P,90000006${tag}0,${therapistB.email}\nUndoB${tag},2021-02-0${tag},Q,,\n`;
    const first = (await (await importAs(owner, csv("1"))).json()) as ImportJson;
    const caseIds = first.items.map((i) => i.case_id);
    const kids = first.items.map((i) => i.child_id);
    as(admin);
    const undo = await (await routes()).undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: first.import.id }));
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ result: "undone", cases: 2, children: 2, series: 0, sessions: 0 });
    expect(await sql`select 1 from cases where id in ${sql(caseIds)}`).toHaveLength(0);
    expect(await sql`select 1 from children where id in ${sql(kids)}`).toHaveLength(0);
    expect(await sql`select 1 from child_claim_codes where case_id in ${sql(caseIds)}`).toHaveLength(0);
    const [imp] = await sql`select undone_at is not null as undone, imported_count from child_imports where id = ${first.import.id}`;
    expect(imp).toEqual({ undone: true, imported_count: 2 });
    expect(await sql`select 1 from audit_events where action = 'children.import_undone' and entity_id = ${first.import.id}`).toHaveLength(1);
    const twice = await (await routes()).undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: first.import.id }));
    expect(twice.status).toBe(409);
    // An undone import frees its file hash: the same file can be imported again.
    expect((await importAs(owner, csv("1"))).status).toBe(201);

    const second = (await (await importAs(owner, csv("2"))).json()) as ImportJson;
    const target = second.items.find((i) => i.row === 3)!;
    await sql`
      insert into reports (case_id, kind, content, content_md, status)
      values (${target.case_id}, 'session_note', '{}'::jsonb, '# Session note (synthetic)', 'draft')`;
    as(owner);
    const blocked = await (await routes()).undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: second.import.id }));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { details: { blocked_rows: number[] } }).details.blocked_rows).toEqual([3]);
    expect(await sql`select 1 from cases where id in ${sql(second.items.map((i) => i.case_id))}`).toHaveLength(2);

    const third = (await (await importAs(owner, csv("3"))).json()) as ImportJson;
    await sql`update child_imports set undo_until = now() - interval '1 second' where id = ${third.import.id}`;
    const late = await (await routes()).undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: third.import.id }));
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("The 24-hour undo window has passed");
  });

  it("roles: a member gets 403, other organisations and malformed ids 404, guardians 403, anonymous 401", async () => {
    const text = withMembers(fixture("telugu-names.csv")).replace("శ్రీజ", "శ్రీజా");
    const [{ before }] = await sql<{ before: number }[]>`select count(*)::int as before from child_imports where org_id = ${orgId}`;
    expect((await previewAs(member, text)).status).toBe(403);
    expect((await importAs(member, text)).status).toBe(403);
    expect((await previewAs(therapistA, text)).status).toBe(403);
    expect((await previewAs(outsider, text)).status).toBe(404); // not a member of orgId
    expect((await previewAs(owner, text, { org: otherOrg })).status).toBe(404);
    expect((await previewAs(owner, text, { org: "not-a-uuid" })).status).toBe(404);
    expect((await previewAs(guardian, text)).status).toBe(403);
    as(null);
    expect((await (await routes()).preview.POST(upload("http://localhost/x", text))).status).toBe(401);
    expect(await sql`select count(*)::int as n from child_imports where org_id = ${orgId}`).toEqual([{ n: before }]);

    const [own] = await sql<{ id: string }[]>`select id from child_imports where org_id = ${orgId} limit 1`;
    const r = await routes();
    for (const [user, status] of [
      [member, 403],
      [outsider, 404],
    ] as const) {
      as(user);
      expect((await r.detail.GET(new Request("http://localhost/x"), ctx({ id: own.id }))).status).toBe(status);
      expect((await r.undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: own.id }))).status).toBe(status);
      expect((await r.codes.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: own.id }))).status).toBe(status);
    }
    as(owner);
    expect((await r.detail.GET(new Request("http://localhost/x"), ctx({ id: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);
  });

  it("timetables that cannot be scheduled (a demo profile) are stored as pending, bad ones are row errors", async () => {
    const res = await importAs(owner, withMembers(fixture("timetable.csv")));
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson & { failed: { row: number }[] };
    expect(body.items.map((i) => i.row)).toEqual([2, 6]);
    expect(body.failed.map((f) => f.row)).toEqual([3, 4, 5]);
    expect(body.import).toMatchObject({ timetable_pending_count: 1 });
    const rows = await sql<{ row_number: number; timetable: { weekdays: number[]; time: string }; timetable_status: string | null }[]>`
      select row_number, timetable, timetable_status from child_import_rows where import_id = ${body.import.id} order by row_number`;
    expect(rows[0]).toMatchObject({ row_number: 2, timetable_status: "pending", timetable: { weekdays: [1, 3, 5], time: "10:00" } });
    expect(rows[1]).toMatchObject({ row_number: 6, timetable_status: null });
  });

  it("a scheduler that reports 043 as available creates series; failures stay pending", async () => {
    const { runImport } = await import("@/lib/import/store");
    const { auditActorOf } = await import("@/lib/audit");
    const created: string[] = [];
    const scheduler = {
      available: async () => true,
      create: async (_tx: unknown, req: { childId: string; weekdays: number[] }) => {
        created.push(req.childId);
        return req.weekdays.includes(1) ? "00000000-0000-4000-8000-0000000005e1" : null;
      },
    };
    const text = withMembers(
      "child_first_name,date_of_birth,guardian_name,therapist_email,weekdays,time,service_name\n" +
        "Seriesyes,2021-03-03,P,therapist.a@clinic.example,Mon,10:00,Speech therapy (synthetic)\n" +
        "Seriesno,2021-03-04,P,therapist.a@clinic.example,Tue,10:00,Speech therapy (synthetic)\n",
    );
    const outcome = await runImport({
      orgId,
      actor: { ...auditActorOf(owner, "provider"), actorUserId: owner.id },
      bytes: new TextEncoder().encode(text),
      importDuplicates: new Set(),
      scheduler,
    });
    expect(outcome.result).toBe("imported");
    if (outcome.result !== "imported") return;
    for (const item of outcome.items) childIds.add(item.child_id);
    expect(created).toHaveLength(2);
    expect(outcome.import).toMatchObject({ series_created_count: 1, timetable_pending_count: 1 });
    const rows = await sql`select row_number, timetable_status, series_id from child_import_rows where import_id = ${outcome.import.id} order by row_number`;
    expect(rows).toEqual([
      { row_number: 2, timetable_status: "scheduled", series_id: "00000000-0000-4000-8000-0000000005e1" },
      { row_number: 3, timetable_status: "pending", series_id: null },
    ]);
  });

  // ---------- 044 extra scope: 043 series from the import ----------

  const seriesCsv = (name: string, weekdays: string, time: string, billing = "") =>
    withMembers(
      "child_first_name,date_of_birth,guardian_name,therapist_email,weekdays,time,service_name,billing_mode\n" +
        `${name},2021-02-02,Parent (synthetic),therapist.b@clinic.example,${weekdays},${time},OT in clinic (synthetic),${billing}\n`,
    );
  const seriesOfImport = async (importId: string) =>
    sql<{ series_id: string; timetable_status: string; weekdays: number[]; billing_mode: string; guardian_user_id: string | null; start_time: string }[]>`
      select ir.series_id, ir.timetable_status, s.weekdays::int[] as weekdays, s.billing_mode, s.guardian_user_id,
             to_char(s.start_time, 'HH24:MI') as start_time
      from child_import_rows ir join appointment_series s on s.id = ir.series_id where ir.import_id = ${importId}`;
  const undoAs = async (user: TestUser, importId: string) => {
    as(user);
    const res = await (await routes()).undo.POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id: importId }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("044: the import creates a 043 weekly series (Mon/Wed/Fri -> 043 numbering, billing_mode) and messages nobody", async () => {
    const res = await importAs(owner, seriesCsv("Seriesreal", "Mon;Wed;Fri", "10:00", "package"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson & { import: { series_created_count: number } };
    expect(body.import).toMatchObject({ timetable_pending_count: 0, series_created_count: 1 });
    const [s] = await seriesOfImport(body.import.id);
    expect(s).toMatchObject({ timetable_status: "scheduled", weekdays: [0, 2, 4], billing_mode: "package", guardian_user_id: null, start_time: "10:00" });
    const sessions = await sql<{ id: string; local: string; dow: number; status: string }[]>`
      select id, to_char(lower(slot) at time zone 'Asia/Kolkata', 'HH24:MI') as local,
             extract(isodow from lower(slot) at time zone 'Asia/Kolkata')::int as dow, status
      from appointments where series_id = ${s.series_id}`;
    expect(sessions.length).toBeGreaterThanOrEqual(23); // 8 weeks of Mon/Wed/Fri from today (today's may be over)
    expect(sessions.every((a) => a.local === "10:00" && [1, 3, 5].includes(a.dow) && a.status === "confirmed")).toBe(true);
    // 047 NFR-2 still holds: no family account, so no series summary, reminders or per-session messages.
    expect(await sql`select 1 from outbox_events where aggregate_type = 'appointment_series' and aggregate_id = ${s.series_id}`).toHaveLength(0);
    expect(await sql`select 1 from outbox_events where aggregate_id in ${sql(sessions.map((a) => a.id))}`).toHaveLength(0);

    // Undo removes the untouched series and its future sessions with the children and cases.
    const undo = await undoAs(owner, body.import.id);
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect(undo.json).toEqual({ result: "undone", cases: 1, children: 1, series: 1, sessions: sessions.length });
    expect(await sql`select 1 from appointment_series where id = ${s.series_id}`).toHaveLength(0);
    expect(await sql`select 1 from appointments where id in ${sql(sessions.map((a) => a.id))}`).toHaveLength(0);
    const [audit] = await sql<{ details: Record<string, unknown> }[]>`
      select details from audit_events where action = 'children.import_undone' and entity_id = ${body.import.id}`;
    expect(audit.details).toMatchObject({ series: 1, sessions: sessions.length });
  });

  it("044: undo is refused once the import's series was touched (a session cancelled, the series paused)", async () => {
    const cancelled = (await (await importAs(owner, seriesCsv("Seriestouched", "Tue;Thu", "11:00"))).json()) as ImportJson;
    const [s1] = await seriesOfImport(cancelled.import.id);
    expect(s1.billing_mode).toBe("per_session"); // empty billing_mode
    const [first] = await sql<{ id: string }[]>`select id from appointments where series_id = ${s1.series_id} order by lower(slot) limit 1`;
    await sql`select public.booking_cancel(${first.id}::uuid, ${owner.id}::uuid, 'provider', 'family away')`;
    const blocked = await undoAs(owner, cancelled.import.id);
    expect(blocked.status).toBe(409);
    expect((blocked.json.details as { blocked_rows: number[] }).blocked_rows).toEqual([2]);
    expect(await sql`select 1 from appointment_series where id = ${s1.series_id}`).toHaveLength(1);
    expect(await sql`select 1 from cases where id = ${cancelled.items[0].case_id}`).toHaveLength(1);

    const paused = (await (await importAs(owner, seriesCsv("Seriespaused", "Sat", "12:00", "free"))).json()) as ImportJson;
    const [s2] = await seriesOfImport(paused.import.id);
    expect(s2.billing_mode).toBe("free");
    const today = new Date().toISOString().slice(0, 10);
    await sql`select public.series_pause(${s2.series_id}::uuid, ${owner.id}::uuid, (${today}::date + 14), (${today}::date + 20))`;
    expect((await undoAs(owner, paused.import.id)).status).toBe(409);
    expect(await sql`select 1 from appointment_series where id = ${s2.series_id}`).toHaveLength(1);
  });

  it("044: pending timetables of an earlier import are scheduled once (button: owner/admin only; script: all imports)", async () => {
    const { runImport } = await import("@/lib/import/store");
    const { schedulePendingTimetables } = await import("@/lib/import/schedule");
    const { auditActorOf } = await import("@/lib/audit");
    // As if imported before 043 existed: the timetable is validated and kept `pending`.
    const before043 = { available: async () => false, create: async () => null };
    const importPending = async (name: string, time: string) => {
      const outcome = await runImport({
        orgId,
        actor: { ...auditActorOf(owner, "provider"), actorUserId: owner.id },
        bytes: new TextEncoder().encode(seriesCsv(name, "Sun", time)),
        importDuplicates: new Set(),
        scheduler: before043,
      });
      if (outcome.result !== "imported") throw new Error(outcome.result);
      for (const item of outcome.items) childIds.add(item.child_id);
      expect(outcome.import).toMatchObject({ timetable_pending_count: 1, series_created_count: 0 });
      return outcome.import.id;
    };
    const importId = await importPending("Pendingone", "14:00");
    const r = await routes();
    const schedule = async (user: TestUser | null, id: string) => {
      as(user);
      const res = await (await import("@/app/api/org/import/[id]/schedule/route")).POST(new Request("http://localhost/x", { method: "POST" }), ctx({ id }));
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    expect((await schedule(member, importId)).status).toBe(403);
    expect((await schedule(outsider, importId)).status).toBe(404);
    expect((await schedule(null, importId)).status).toBe(401);
    const first = await schedule(owner, importId);
    expect(first).toEqual({ status: 200, json: { scheduled: 1, pending: 0 } });
    const [s] = await seriesOfImport(importId);
    expect(s).toMatchObject({ timetable_status: "scheduled", weekdays: [6], billing_mode: "per_session" }); // Sun = 6 in 043
    expect(await sql`select 1 from appointments where series_id = ${s.series_id}`).not.toHaveLength(0);
    expect((await schedule(owner, importId)).json).toEqual({ scheduled: 0, pending: 0 }); // idempotent
    expect(await sql`select 1 from appointment_series where id in (select series_id from child_import_rows where import_id = ${importId})`).toHaveLength(1);
    const [counts] = await sql`select timetable_pending_count, series_created_count from child_imports where id = ${importId}`;
    expect(counts).toEqual({ timetable_pending_count: 0, series_created_count: 1 });
    expect(await sql`select 1 from audit_events where action = 'children.import_timetables_scheduled' and entity_id = ${importId}`).toHaveLength(1);
    as(owner);
    const detail = await r.detail.GET(new Request("http://localhost/x"), ctx({ id: importId }));
    expect(detail.status).toBe(200);

    // `npm run import:schedule-pending`: every import of the organisation, as the owner/admin who made it.
    const second = await importPending("Pendingtwo", "15:00");
    // Earlier tests of this suite left timetables that can never be scheduled (therapist A's demo profile): they stay
    // pending and are retried harmlessly.
    expect(await schedulePendingTimetables({ orgId })).toMatchObject({ scheduled: 1 });
    expect((await schedulePendingTimetables({ orgId })).scheduled).toBe(0);
    expect((await seriesOfImport(second))[0].timetable_status).toBe("scheduled");
  });

  it("NFR-1: 500 rows import in under 30 s", async () => {
    const lines = ["child_first_name,child_last_name,date_of_birth,guardian_name,guardian_phone,preferred_language,therapist_email"];
    for (let i = 0; i < 500; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String((i % 12) + 1).padStart(2, "0");
      lines.push(`Bulk${i},Load (synthetic),${day}/${month}/202${i % 5},Parent ${i},9${String(100000000 + i).padStart(9, "0")},${["en", "hi", "te"][i % 3]},${i % 2 ? therapistA.email : therapistB.email}`);
    }
    const started = performance.now();
    const res = await importAs(owner, `${lines.join("\n")}\n`);
    const seconds = (performance.now() - started) / 1000;
    expect(res.status).toBe(201);
    const body = (await res.json()) as ImportJson;
    expect(body.import.imported_count).toBe(500);
    expect(body.items).toHaveLength(500);
    expect(seconds).toBeLessThan(30);
    console.info(`047 NFR-1: 500-row import took ${seconds.toFixed(2)} s`);
  });

  it("a file over 1 MB is refused", async () => {
    const big = `child_first_name,date_of_birth,guardian_name,notes\n${"A,2021-01-01,P,x\n".repeat(70_000)}`;
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await previewAs(owner, big);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("The file is larger than 1 MB.");
  });
});
