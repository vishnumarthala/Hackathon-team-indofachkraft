// Integration checks for the speaker swap against the configured database (DATABASE_URL). Skipped when
// it is not set or SKIP_DB_TESTS=1. Every test creates its own synthetic case and deletes only that case.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SWAP_BLOCKED, needsReextraction, swapSpeakers } from "@/lib/speakers";
import { EXTRACTION_RUNNING, bulkUpdate, updateFact } from "@/lib/facts";
import { IsaaExtractionSchema, SegmentSchema } from "@/lib/types";
import { buildIsaaFacts } from "../scripts/seed-demo";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const fixture = (rel: string) => JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures", rel), "utf8"));
const segments = SegmentSchema.array().parse(fixture("roleplay-segments.json"));
const extract = IsaaExtractionSchema.parse(fixture("gemini/extract.json"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("speaker swap (database)", () => {
  let sql: Sql;
  const created: string[] = [];

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    if (created.length) await sql`delete from cases where id in ${sql(created)}`;
    await sql.end({ timeout: 5 });
  });

  // An extracted synthetic session with all 40 AI suggestions, evidence and two extraction red flags.
  async function seed() {
    const caseId = randomUUID();
    const sessionId = randomUUID();
    created.push(caseId);
    await sql`
      insert into cases (org_id, id, child_alias, parent_alias, language, therapist_name, status)
      values ('00000000-0000-4000-8000-00000000a001', ${caseId}, ${`t008-db-${caseId.slice(0, 8)} (synthetic)`}, 'Parent (synthetic)', 'en', 'Demo Therapist', 'in_assessment')`;
    await sql`
      insert into recordings (id, case_id, kind, session_number, status, speaker_map, segments, red_flags)
      values (${sessionId}, ${caseId}, 'session', 1, 'extracted',
              ${sql.json({ speaker_0: "therapist", speaker_1: "parent" })}, ${sql.json(segments as unknown as postgres.JSONValue)},
              ${sql.json([{ type: "lost_speech", segment_id: "s1", quote: "q", note: "n" }])})`;
    const facts = buildIsaaFacts({
      caseId,
      sessionId,
      extract,
      segments,
      therapistName: "Demo Therapist",
      confirmed: false,
      now: new Date().toISOString(),
    });
    await sql`
      insert into facts (case_id, recording_id, instrument, item_id, value, ai_value, source, evidence, confidence,
                         rationale, status, confirmed_by, confirmed_at)
      select x.case_id, x.recording_id, x.instrument, x.item_id, x.value, x.ai_value, x.source, x.evidence,
             x.confidence, x.rationale, x.status, x.confirmed_by, x.confirmed_at
      from jsonb_to_recordset(${sql.json(facts as unknown as postgres.JSONValue)}) as x(case_id uuid, recording_id uuid, instrument text,
        item_id text, value jsonb, ai_value jsonb, source text, evidence jsonb, confidence numeric, rationale text,
        status text, confirmed_by text, confirmed_at timestamptz)`;
    return { caseId, sessionId };
  }

  const factState = (sessionId: string) => sql<{ n: number; with_data: number; not_suggested: number; non_session: number }[]>`
    select count(*)::int as n,
           count(*) filter (where value is not null or ai_value is not null or evidence is not null
                              or confidence is not null or rationale is not null or confirmed_by is not null
                              or confirmed_at is not null)::int as with_data,
           count(*) filter (where status <> 'suggested')::int as not_suggested,
           count(*) filter (where source <> 'session')::int as non_session
    from facts where recording_id = ${sessionId}`;

  it("clears every mapping-dependent value, red flags and swaps map and segments, with one audit event", async () => {
    const { sessionId } = await seed();
    const before = await sql`select count(*)::int as n from facts where recording_id = ${sessionId} and value is not null`;
    expect(before[0].n).toBeGreaterThan(0);

    const result = await swapSpeakers(sessionId);
    expect(result).toEqual({
      ok: true,
      data: { speaker_map: { speaker_0: "parent", speaker_1: "therapist" }, segments_count: segments.length },
    });

    expect((await factState(sessionId))[0]).toEqual({ n: 40, with_data: 0, not_suggested: 0, non_session: 0 });
    const [rec] = await sql<{ red_flags: unknown[]; speakers: string[]; status: string }[]>`
      select red_flags, status, (select array_agg(distinct s->>'speaker') from jsonb_array_elements(segments) s) as speakers
      from recordings where id = ${sessionId}`;
    expect(rec.red_flags).toEqual([]);
    expect(rec.status).toBe("extracted");
    expect(rec.speakers.sort()).toEqual(["parent", "therapist"]);
    const audit = await sql`select count(*)::int as n from audit_events where entity_id = ${sessionId} and action = 'recording.speakers_swapped'`;
    expect(audit[0].n).toBe(1);
  });

  it("waits for a manual decision that is committing and then refuses (no race)", async () => {
    const { sessionId } = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The "therapist" transaction takes the recording lock first, as updateFact does, and edits an item.
    const decision = sql.begin(async (tx) => {
      await tx`select id from recordings where id = ${sessionId} for update`;
      await tx`update facts set value = to_jsonb(2::int), status = 'edited' where recording_id = ${sessionId} and item_id = '3'`;
      await gate;
    });
    await sleep(300);
    const swap = swapSpeakers(sessionId);
    await sleep(500);
    release();
    await decision;

    expect(await swap).toEqual({ ok: false, status: 409, error: SWAP_BLOCKED });
    const [fact] = await sql`select value, status from facts where recording_id = ${sessionId} and item_id = '3'`;
    expect(fact).toEqual({ value: 2, status: "edited" });
    const kept = await sql`select count(*)::int as n from facts where recording_id = ${sessionId} and value is not null`;
    expect(kept[0].n).toBeGreaterThan(1);
  });

  it("waits for an extraction that is claiming the session and then refuses", async () => {
    const { sessionId } = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const claim = sql.begin(async (tx) => {
      await tx`update recordings set status = 'extracting' where id = ${sessionId}`;
      await gate;
    });
    await sleep(300);
    const swap = swapSpeakers(sessionId);
    await sleep(500);
    release();
    await claim;

    expect(await swap).toEqual({ ok: false, status: 409, error: EXTRACTION_RUNNING });
    const kept = await sql`select count(*)::int as n from facts where recording_id = ${sessionId} and value is not null`;
    expect(kept[0].n).toBeGreaterThan(1);
  });

  it("a reader that takes the lock concurrently sees either all old values or none, never a mix", async () => {
    const { sessionId } = await seed();
    const [{ n: rated }] = await sql<{ n: number }[]>`select count(*)::int as n from facts where recording_id = ${sessionId} and value is not null`;
    const swap = swapSpeakers(sessionId);
    const reader = sql.begin(async (tx) => {
      await tx`select id from recordings where id = ${sessionId} for update`;
      return tx<{ n: number }[]>`select count(*)::int as n from facts where recording_id = ${sessionId} and value is not null`;
    });
    const [outcome, seen] = await Promise.all([swap, reader]);
    expect(outcome.ok).toBe(true);
    expect([0, rated]).toContain(seen[0].n);
    expect((await factState(sessionId))[0].with_data).toBe(0);
  });

  it("swap racing a real updateFact ends in one of the two serial orders, never a mix", async () => {
    const { sessionId } = await seed();
    const [fact] = await sql<{ id: string }[]>`select id from facts where recording_id = ${sessionId} and item_id = '3'`;
    const [edit, swap] = await Promise.all([updateFact(fact.id, { action: "edit", value: 2 }), swapSpeakers(sessionId)]);
    const after = (await factState(sessionId))[0];
    const [row] = await sql`select value, status, ai_value from facts where id = ${fact.id}`;
    expect(edit.ok).toBe(true);
    if (swap.ok) {
      // Swap first: everything cleared, then the edit landed on the cleared item.
      expect(row).toEqual({ value: 2, status: "edited", ai_value: null });
      expect(after.with_data).toBe(1);
    } else {
      // Edit first: the swap saw a manual decision and changed nothing else.
      expect(swap).toEqual({ ok: false, status: 409, error: SWAP_BLOCKED });
      expect(after.with_data).toBe(40);
    }
  });

  it("swap racing a real bulkUpdate ends in one of the two serial orders", async () => {
    const { sessionId } = await seed();
    const [bulk, swap] = await Promise.all([bulkUpdate(sessionId, { action: "confirm_suggested" }), swapSpeakers(sessionId)]);
    const after = (await factState(sessionId))[0];
    if (swap.ok) {
      // Swap first: nothing is left to confirm; the bulk call confirmed 0 items.
      expect(bulk.ok && bulk.data.updated).toBe(0);
      expect(after.with_data).toBe(0);
    } else {
      expect(swap).toEqual({ ok: false, status: 409, error: SWAP_BLOCKED });
      expect(after.not_suggested).toBeGreaterThan(0);
    }
  });

  it("needsReextraction is true after a swap until an extraction completes", async () => {
    const { caseId, sessionId } = await seed();
    expect(await needsReextraction(sessionId)).toBe(false);
    expect((await swapSpeakers(sessionId)).ok).toBe(true);
    expect(await needsReextraction(sessionId)).toBe(true);
    await sql`insert into audit_events (case_id, actor, action, entity, entity_id, details)
              values (${caseId}, 'ai', 'extraction.completed', 'recording', ${sessionId}, '{}'::jsonb)`;
    expect(await needsReextraction(sessionId)).toBe(false);
  });
});
