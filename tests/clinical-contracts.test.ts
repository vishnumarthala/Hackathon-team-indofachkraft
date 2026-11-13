// Ticket 024 Part 1 (FR-1..FR-6): shared clinical contracts. Pure checks of the instrument registry, report
// kinds, speaker roles and the parent check-in scoring; database checks (local Supabase, DATABASE_URL) of the
// instrument foreign key, published_versions (append-only, hash, versions, RLS), report finalisation publishing
// in the same transaction (E-1) and the backfill. Synthetic data only; everything is removed afterwards.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHECKIN,
  CHECKIN_ITEM_IDS,
  RED_FLAG_CODES,
  bandForTotal,
  missingCheckinItems,
  questionPoints,
  scoreCheckin,
  type CheckinAnswer,
} from "@/lib/clinical/checkin";
import { INSTRUMENT_KEYS, INSTRUMENT_SOURCES, getInstrument, score } from "@/lib/clinical/instruments";
import { REPORT_KINDS, REPORT_KIND_KEYS, defaultVisibleToGuardian } from "@/lib/clinical/reports";
import { SPEAKER_LABEL_KEYS, SPEAKER_LABELS_EN, SPEAKER_ROLES } from "@/lib/clinical/speakers";
import { contentHash } from "@/lib/clinical/publish";
import { scoreIsaa } from "@/lib/scoring";
import { swapRole, swapSegments, swapSpeakerMap } from "@/lib/speaker-swap";
import { SegmentSchema, SpeakerRoleSchema, type Segment } from "@/lib/types";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const readJson = (rel: string) => JSON.parse(readFileSync(path.join(process.cwd(), rel), "utf8"));

/** A complete check-in answer set: every question gets the answer worth `points[i]` (default 0), red flags `no`. */
function answersFor(points: number[] = [], redFlags: string[] = []): Record<string, string> {
  const answers: Record<string, string> = {};
  CHECKIN.questions.forEach((q, i) => {
    const target = points[i] ?? 0;
    answers[q.id] = CHECKIN.answer_scale.find((a) => questionPoints(q, a) === target) as CheckinAnswer;
  });
  for (const r of CHECKIN.red_flags) answers[r.id] = redFlags.includes(r.code) ? "yes" : "no";
  return answers;
}

/** Spreads `total` points over the 15 questions (max 3 each). */
const spread = (total: number) => CHECKIN.questions.map((_, i) => Math.max(0, Math.min(3, total - i * 3)));

describe("instrument registry (FR-1)", () => {
  it("loads ISAA, CASE_SHEET and ISAA_PARENT_CHECKIN with typed items", () => {
    expect([...INSTRUMENT_KEYS]).toEqual(["ISAA", "CASE_SHEET", "ISAA_PARENT_CHECKIN"]);
    const isaa = getInstrument("ISAA");
    expect(isaa).toMatchObject({ key: "ISAA", kind: "provider_rated", version: "1" });
    expect(isaa.items).toHaveLength(40);
    expect(isaa.items[0]).toMatchObject({ id: "1", domain: "social", text: "Has poor eye contact", scale: { type: "rating" } });
    expect(isaa.items.find((i) => i.id === "15")?.red_flag).toEqual(["lost_speech"]);
    expect(isaa.items.find((i) => i.id === "29")?.red_flag).toEqual(["self_injury"]);
    expect(isaa.items.filter((i) => i.red_flag)).toHaveLength(2);

    const sheet = getInstrument("CASE_SHEET");
    expect(sheet.kind).toBe("case_sheet");
    expect(sheet.items.map((i) => i.id)).toEqual(readJson("schemas/case-sheet.json").fields.map((f: { id: string }) => f.id));

    const checkin = getInstrument("ISAA_PARENT_CHECKIN");
    expect(checkin.kind).toBe("guardian_questionnaire");
    expect(checkin.items.map((i) => i.id)).toEqual(CHECKIN_ITEM_IDS);
    expect(checkin.items.filter((i) => i.reverse).map((i) => i.id)).toEqual(CHECKIN.questions.filter((q) => q.reverse).map((q) => q.id));
    expect(getInstrument("MCHAT")).toBeNull();
  });

  it("ISAA scoring delegates to the unchanged lib/scoring.ts", () => {
    const facts = Array.from({ length: 40 }, (_, i) => ({ item_id: String(i + 1), value: (i % 5) + 1, status: i % 3 ? "confirmed" : "suggested" }));
    expect(score("ISAA", facts)).toEqual({ key: "ISAA", result: scoreIsaa(facts) });
    expect(() => score("CASE_SHEET", {})).toThrow(/not a scored instrument/);
  });
});

describe("report kinds (FR-2)", () => {
  it("lists the kinds in use plus the reserved ones, with audiences", () => {
    expect(REPORT_KIND_KEYS).toEqual(["pre_session_brief", "assessment", "parent_summary", "session_note", "rx_draft", "generic_intake_brief"]);
    // 038 started producing session_note and rx_draft (migration 20261113003800_scribe.sql).
    expect(REPORT_KIND_KEYS.filter((k) => REPORT_KINDS[k].inUse)).toEqual(["pre_session_brief", "assessment", "parent_summary", "session_note", "rx_draft"]);
    expect(defaultVisibleToGuardian("assessment")).toBe(false);
    expect(defaultVisibleToGuardian("parent_summary")).toBe(true);
    expect(defaultVisibleToGuardian("pre_session_brief")).toBe(false);
  });
});

describe("speaker roles (FR-5)", () => {
  it("keeps the stored values and adds child / other_adult with labels", () => {
    expect([...SPEAKER_ROLES]).toEqual(["therapist", "parent", "agent", "unknown", "child", "other_adult"]);
    for (const role of SPEAKER_ROLES) expect(SpeakerRoleSchema.parse(role)).toBe(role);
    expect(SpeakerRoleSchema.safeParse("teacher").success).toBe(false);
    expect(SPEAKER_LABELS_EN.therapist).toBe("Clinician");
    expect(SPEAKER_LABELS_EN.parent).toBe("Parent or caregiver");
    expect(Object.keys(SPEAKER_LABEL_KEYS)).toEqual([...SPEAKER_ROLES]);
  });

  it("swap exchanges therapist <-> parent only and leaves child / other_adult / agent / unknown untouched", () => {
    expect(swapRole("therapist")).toBe("parent");
    expect(swapRole("parent")).toBe("therapist");
    for (const role of ["child", "other_adult", "agent", "unknown"] as const) expect(swapRole(role)).toBe(role);
    expect(swapSpeakerMap({ speaker_0: "therapist", speaker_1: "parent", speaker_2: "child", speaker_3: "other_adult" })).toEqual({
      speaker_0: "parent",
      speaker_1: "therapist",
      speaker_2: "child",
      speaker_3: "other_adult",
    });
    const segments: Segment[] = SegmentSchema.array().parse([
      { id: "s1", speaker: "child", speaker_label: "speaker_2", start_sec: 0, end_sec: 1, text: "ball" },
      { id: "s2", speaker: "therapist", speaker_label: "speaker_0", start_sec: 1, end_sec: 2, text: "Ready?" },
      { id: "s3", speaker: "other_adult", speaker_label: "speaker_3", start_sec: 2, end_sec: 3, text: "Yes" },
    ]);
    expect(swapSegments(segments).map((s) => s.speaker)).toEqual(["child", "parent", "other_adult"]);
  });
});

describe("ISAA parent check-in (FR-4)", () => {
  it("has 15 parent questions over the six ISAA domains, the red-flag questions and fixed copy", () => {
    const json = readJson("schemas/isaa-parent-checkin.json");
    expect(json.instrument).toBe("ISAA_PARENT_CHECKIN");
    expect(json.questions).toHaveLength(15);
    expect(new Set(json.questions.map((q: { domain: string }) => q.domain))).toEqual(
      new Set(["social", "emotional", "speech", "behaviour", "sensory", "cognitive"]),
    );
    for (const q of json.questions) {
      expect(q.answer_scale).toEqual(["never", "sometimes", "often", "always"]);
      expect(q.text_en.length).toBeGreaterThan(10);
      expect(q.age_bands.length).toBeGreaterThan(0);
      expect(q.isaa_items.every((n: number) => n >= 1 && n <= 40)).toBe(true);
      expect(q).not.toHaveProperty("text_hi");
      expect(q).not.toHaveProperty("text_te");
    }
    expect(json.red_flags.map((r: { code: string }) => r.code)).toEqual([...RED_FLAG_CODES]);
    for (const band of ["no_strong_signs", "discuss_with_professional", "see_professional_soon"]) {
      expect(json.result_copy[band]).toContain("This is a developmental check-in, not a diagnosis.");
      expect(json.result_copy[band].replace(/not a diagnosis/g, "")).not.toMatch(/diagnos/i);
    }
    expect(json.urgent_copy).toBe("Please contact your child's doctor now. In an emergency call 108 (ambulance) or 112.");
  });

  it.each([
    [0, "no_strong_signs"],
    [9, "no_strong_signs"],
    [10, "discuss_with_professional"],
    [19, "discuss_with_professional"],
    [20, "see_professional_soon"],
    [45, "see_professional_soon"],
  ] as const)("total %i -> %s", (total, band) => {
    const result = scoreCheckin(answersFor(spread(total)));
    expect(result).toMatchObject({ complete: true, total, band, red_flags: [], answered: 15, max_total: 45 });
    expect(result.result_text).toBe(CHECKIN.result_copy[band]);
    expect(bandForTotal(total)).toBe(band);
  });

  it("reverse-worded questions score 'never' as the concern", () => {
    const reverse = CHECKIN.questions.find((q) => q.reverse)!;
    const forward = CHECKIN.questions.find((q) => !q.reverse)!;
    expect(questionPoints(reverse, "never")).toBe(3);
    expect(questionPoints(reverse, "always")).toBe(0);
    expect(questionPoints(forward, "always")).toBe(3);
  });

  it.each(RED_FLAG_CODES.map((c) => [c]))("red flag %s answered yes -> see_professional_soon whatever the total", (code) => {
    const result = scoreCheckin(answersFor([], [code]));
    expect(result).toMatchObject({ complete: true, total: 0, band: "see_professional_soon", red_flags: [code] });
  });

  it("partial answers: no band, missing items in form order", () => {
    const answers = answersFor();
    delete answers.q3;
    delete answers.rf_seizure;
    expect(missingCheckinItems(answers)).toEqual(["q3", "rf_seizure"]);
    expect(scoreCheckin(answers)).toMatchObject({ complete: false, band: null, answered: 14, result_text: null });
    expect(missingCheckinItems({ ...answersFor(), q1: "maybe" })).toEqual(["q1"]);
  });

  it("content hash is sha256 of the UTF-8 markdown", () => {
    const md = "# रिपोर्ट\n\nసారాంశం";
    expect(contentHash(md)).toBe(createHash("sha256").update(Buffer.from(md, "utf8")).digest("hex"));
  });
});

describe.skipIf(!enabled)("clinical contracts (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let owner: TestUser, guardian: TestUser, otherGuardian: TestUser, outsider: TestUser;
  let orgId: string;
  let kase: Awaited<ReturnType<ReturnType<typeof createWorld>["kase"]>>;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t024c");
    owner = await world.user("owner", "provider");
    outsider = await world.user("outsider", "provider");
    guardian = await world.user("guardian", "guardian");
    otherGuardian = await world.user("guardian2", "guardian");
    orgId = await world.org(owner, "Contracts centre");
    await world.org(outsider, "Other centre");
    kase = await world.kase(orgId);
    await world.link(kase.childId, guardian);
  });

  afterAll(async () => {
    session.user = null;
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  const versions = (entityId: string) =>
    sql<{ version: number; content_md: string; content_hash: string; visible_to_guardian: boolean; published_by: string | null }[]>`
      select version, content_md, content_hash, visible_to_guardian, published_by
      from published_versions where entity_id = ${entityId} order by version`;

  it("clinical_instruments mirrors schemas/*.json", async () => {
    const rows = await sql<{ key: string; version: string; kind: string; definition: unknown; active: boolean }[]>`
      select key, version, kind, definition, active from clinical_instruments order by key`;
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining([...INSTRUMENT_KEYS]));
    for (const key of INSTRUMENT_KEYS) {
      const row = rows.find((r) => r.key === key)!;
      expect(row.definition, key).toEqual(INSTRUMENT_SOURCES[key]);
      expect(row.kind).toBe(getInstrument(key).kind);
      expect(row.version).toBe(getInstrument(key).version);
      expect(row.active).toBe(true);
    }
  });

  it("facts.instrument is a foreign key to the registry (unknown instrument fails)", async () => {
    const insert = (instrument: string) => sql`
      insert into facts (case_id, recording_id, instrument, item_id, source)
      values (${kase.caseId}, ${kase.recordingId}, ${instrument}, ${`t024-${randomUUID().slice(0, 6)}`}, 'session')`;
    await expect(insert("MCHAT")).rejects.toThrow(/facts_instrument_fkey/);
    await expect(insert("ISAA")).resolves.toBeDefined();
    const checks = await sql`select conname from pg_constraint where conrelid = 'public.facts'::regclass and conname = 'facts_instrument_check'`;
    expect(checks).toHaveLength(0);
  });

  it("a final report has exactly one published version (inserted final -> v1, provider only)", async () => {
    const [{ content_md }] = await sql<{ content_md: string }[]>`select content_md from reports where id = ${kase.reportId}`;
    const rows = await versions(kase.reportId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, content_md, visible_to_guardian: false });
    expect(rows[0].content_hash).toBe(contentHash(content_md));
  });

  it("published_versions is append-only: update, delete and truncate raise", async () => {
    await expect(sql`update published_versions set visible_to_guardian = true where entity_id = ${kase.reportId}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from published_versions where entity_id = ${kase.reportId}`).rejects.toThrow(/append-only/);
    await expect(sql`truncate published_versions`).rejects.toThrow(/append-only/);
    expect(await versions(kase.reportId)).toHaveLength(1);
  });

  it("the service role cannot write published_versions directly; publish_version() is the only writer", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role service_role`;
        await tx`insert into published_versions (entity_type, entity_id, version, child_id, org_id, content_md, content_hash)
                 values ('report', ${randomUUID()}, 1, ${kase.childId}, ${orgId}, 'x', ${contentHash("x")})`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("publishVersion: versions 1, 2, ...; case decides child/org; mismatches are rejected", async () => {
    const { publishVersion } = await import("@/lib/clinical/publish");
    const entityId = randomUUID();
    const v1 = await publishVersion(sql, { entityType: "iep_plan", entityId, caseId: kase.caseId, contentMd: "# Plan v1", visibleToGuardian: true, publishedBy: owner.id });
    const v2 = await publishVersion(sql, { entityType: "iep_plan", entityId, caseId: kase.caseId, contentMd: "# Plan v2", visibleToGuardian: false });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v1).toMatchObject({ child_id: kase.childId, org_id: orgId, published_by: owner.id, content_hash: contentHash("# Plan v1") });
    expect(v2.published_by).toBeNull();
    await expect(
      publishVersion(sql, { entityType: "iep_plan", entityId, caseId: kase.caseId, orgId: randomUUID(), contentMd: "x", visibleToGuardian: false }),
    ).rejects.toThrow(/do not match the case/);
    await expect(publishVersion(sql, { entityType: "iep_plan", entityId, caseId: kase.caseId, contentMd: "  ", visibleToGuardian: false })).rejects.toThrow(
      /content_md is required/,
    );

    // The latest version decides guardian visibility: v2 is hidden, so v1 is no longer shown.
    const { listGuardianVisible, getLatestPublished } = await import("@/lib/clinical/publish");
    expect((await getLatestPublished(sql, "iep_plan", entityId))?.version).toBe(2);
    expect((await listGuardianVisible(sql, kase.childId, "iep_plan")).map((v) => v.entity_id)).not.toContain(entityId);
    const visible = await publishVersion(sql, { entityType: "iep_plan", entityId, caseId: kase.caseId, contentMd: "# Plan v3", visibleToGuardian: true });
    expect((await listGuardianVisible(sql, kase.childId, "iep_plan")).find((v) => v.entity_id === entityId)?.version).toBe(visible.version);
  });

  it("E-1: PATCH final publishes v1 in the same transaction; a second PATCH -> 409 and no new version", async () => {
    const reportId = randomUUID();
    await sql`
      insert into reports (id, case_id, recording_id, kind, content, content_md, status)
      values (${reportId}, ${kase.caseId}, ${null}, 'assessment', '{"background":"draft input"}'::jsonb, '# Draft (synthetic)', 'draft')`;
    expect(await versions(reportId)).toHaveLength(0);
    session.user = owner;
    const { PATCH } = await import("@/app/api/reports/[id]/route");
    const edited = await PATCH(post("http://x", { content_md: "# Final assessment (synthetic)\n\nConfirmed." }, "PATCH"), ctx({ id: reportId }));
    expect(edited.status).toBe(200);
    expect(await versions(reportId)).toHaveLength(0);
    const res = await PATCH(post("http://x", { status: "final" }, "PATCH"), ctx({ id: reportId }));
    expect(res.status).toBe(200);
    const rows = await versions(reportId);
    expect(rows).toEqual([
      expect.objectContaining({
        version: 1,
        content_md: "# Final assessment (synthetic)\n\nConfirmed.",
        visible_to_guardian: false,
        published_by: owner.id,
        content_hash: contentHash("# Final assessment (synthetic)\n\nConfirmed."),
      }),
    ]);
    const again = await PATCH(post("http://x", { content_md: "changed" }, "PATCH"), ctx({ id: reportId }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Report is final" });
    expect(await versions(reportId)).toHaveLength(1);

    session.user = outsider;
    const other = await PATCH(post("http://x", { status: "final" }, "PATCH"), ctx({ id: reportId }));
    expect(other.status).toBe(404);
    session.user = null;
  });

  it("parent summaries publish visible to the guardian; a regenerated summary is a new version", async () => {
    const reportId = randomUUID();
    await sql`
      insert into reports (id, case_id, recording_id, kind, content, content_md, status)
      values (${reportId}, ${kase.caseId}, ${null}, 'parent_summary', '{}'::jsonb, 'Summary one (synthetic).', 'final')`;
    await sql`update reports set content_md = 'Summary two (synthetic).' where id = ${reportId}`;
    await sql`update reports set email_status = 'demo' where id = ${reportId}`;
    expect((await versions(reportId)).map((v) => [v.version, v.content_md, v.visible_to_guardian])).toEqual([
      [1, "Summary one (synthetic).", true],
      [2, "Summary two (synthetic).", true],
    ]);
  });

  it("backfill: a pre-existing final report without a version gets exactly one; re-running publishes nothing", async () => {
    const legacyId = randomUUID();
    // Simulate a report finalised before 024 (no trigger): replica mode skips triggers (local test DB only).
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into reports (id, case_id, recording_id, kind, content, content_md, status)
               values (${legacyId}, ${kase.caseId}, ${null}, 'assessment', '{}'::jsonb, '# Legacy final (synthetic)', 'final')`;
    });
    expect(await versions(legacyId)).toHaveLength(0);
    const [{ n }] = await sql<{ n: number }[]>`select public.backfill_published_reports() as n`;
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await versions(legacyId)).map((v) => v.version)).toEqual([1]);
    const [{ n: again }] = await sql<{ n: number }[]>`select public.backfill_published_reports() as n`;
    expect(again).toBe(0);
    // This suite's case only: suites running in parallel (e.g. sharing-grants) legitimately publish v2 of their reports.
    const [{ missing }] = await sql<{ missing: number }[]>`
      select count(*)::int as missing from reports r
      where r.status = 'final' and r.kind = 'assessment' and r.case_id = ${kase.caseId}
        and (select count(*) from published_versions pv where pv.entity_type = 'report' and pv.entity_id = r.id) <> 1`;
    expect(missing).toBe(0);
  });

  it("RLS: guardians read only visible versions of their children; the care team reads its cases; others nothing", async () => {
    const { publishVersion } = await import("@/lib/clinical/publish");
    await publishVersion(sql, { entityType: "home_program", entityId: randomUUID(), caseId: kase.caseId, contentMd: "# Visible", visibleToGuardian: true });
    const read = (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        return tx<{ visible_to_guardian: boolean }[]>`select visible_to_guardian from published_versions where child_id = ${kase.childId}`;
      });
    const asGuardian = await read(guardian.id);
    expect(asGuardian.length).toBeGreaterThan(0);
    expect(asGuardian.every((r) => r.visible_to_guardian)).toBe(true);
    expect((await read(owner.id)).some((r) => !r.visible_to_guardian)).toBe(true);
    expect(await read(otherGuardian.id)).toHaveLength(0);
    expect(await read(outsider.id)).toHaveLength(0);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`select public.publish_version(${tx.json({ entity_type: "report", entity_id: randomUUID(), case_id: kase.caseId, content_md: "x" })}::jsonb)`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("deleting a case removes its published versions (the only allowed delete)", async () => {
    const extra = await world.kase(orgId);
    expect(await versions(extra.reportId)).toHaveLength(1);
    await sql`delete from cases where id = ${extra.caseId}`;
    expect(await versions(extra.reportId)).toHaveLength(0);
  });

  it("a case re-pointed to the guardian's child (020 placeholder merge) takes its published versions along", async () => {
    const extra = await world.kase(orgId);
    const childOf = async () => (await sql<{ child_id: string }[]>`select child_id from published_versions where entity_id = ${extra.reportId}`)[0].child_id;
    expect(await childOf()).toBe(extra.childId);
    // claim_child does exactly this update when the guardian picks `Is this one of your children?`.
    await sql`update cases set child_id = ${kase.childId} where id = ${extra.caseId}`;
    expect(await childOf()).toBe(kase.childId);
    await expect(sql`update published_versions set child_id = ${extra.childId} where entity_id = ${extra.reportId}`).rejects.toThrow(/append-only/);
    const { listGuardianVisible } = await import("@/lib/clinical/publish");
    expect((await listGuardianVisible(sql, kase.childId)).every((v) => v.child_id === kase.childId)).toBe(true);
    await sql`delete from cases where id = ${extra.caseId}`;
  });
});
