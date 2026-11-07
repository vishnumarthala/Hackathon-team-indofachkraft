// Integration checks against the configured database (DATABASE_URL). Skipped when it is not set
// or SKIP_DB_TESTS=1. Every test creates its own synthetic case and deletes only that case.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExtraction, type ExtractionDeps } from "@/lib/extraction";
import { IsaaExtractionSchema, SegmentSchema, type IsaaExtraction } from "@/lib/types";
import { buildIsaaFacts } from "../scripts/seed-demo";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const fixture = (rel: string) => JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures", rel), "utf8"));
const segments = SegmentSchema.array().parse(fixture("roleplay-segments.json"));
const extract = IsaaExtractionSchema.parse(fixture("gemini/extract.json"));

// A second model answer that differs from the seeded one, so overwrites are visible.
const rerun: IsaaExtraction = {
  ...extract,
  items: extract.items.map((i) => (i.rating === null ? i : { ...i, rating: i.rating === 5 ? 4 : ((i.rating + 1) as 2 | 3 | 4 | 5) })),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("extraction persistence (database)", () => {
  let sql: Sql;
  const created: string[] = [];

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    if (created.length) await sql`delete from cases where id in ${sql(created)}`;
    await sql.end({ timeout: 5 });
  });

  async function seed(stage: "transcribed" | "extracted", caseStatus = "in_assessment") {
    const caseId = randomUUID();
    const sessionId = randomUUID();
    created.push(caseId);
    await sql`
      insert into cases (id, child_alias, parent_alias, language, therapist_name, status)
      values (${caseId}, ${`t006-db-${caseId.slice(0, 8)} (synthetic)`}, 'Parent (synthetic)', 'en', 'Demo Therapist', ${caseStatus})`;
    await sql`
      insert into recordings (id, case_id, kind, session_number, status, speaker_map, segments)
      values (${sessionId}, ${caseId}, 'session', 1, ${stage},
              ${sql.json({ speaker_0: "therapist", speaker_1: "parent" })}, ${sql.json(segments as unknown as postgres.JSONValue)})`;
    if (stage === "extracted") {
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
    }
    return { caseId, sessionId };
  }

  const snapshot = (sessionId: string) => sql`
    select item_id, value, ai_value, status, source, evidence, confidence::float8 as confidence, rationale
    from facts where recording_id = ${sessionId} order by item_id::int`;
  const recording = async (sessionId: string) =>
    (await sql`select r.status, r.error, c.status as case_status from recordings r join cases c on c.id = r.case_id where r.id = ${sessionId}`)[0];
  const audits = async (sessionId: string) =>
    (await sql`select action from audit_events where entity_id = ${sessionId} order by id`).map((r) => r.action);
  const deps = (over: Partial<ExtractionDeps> = {}): ExtractionDeps => ({ sql, generate: async () => rerun, ...over });

  it("rolls back everything when the upsert fails (re-extraction)", async () => {
    const { sessionId } = await seed("extracted");
    const before = await snapshot(sessionId);
    const outcome = await runExtraction(
      sessionId,
      deps({
        hooks: {
          beforeUpsert: (rows) => {
            rows[rows.length - 1].confidence = 7; // violates facts.confidence check
          },
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: false, status: 502, error: "Extraction failed" });
    expect(await snapshot(sessionId)).toEqual(before);
    const rec = await recording(sessionId);
    expect(rec.status).toBe("extracted");
    expect(rec.error).toMatch(/check constraint/i);
    expect(await audits(sessionId)).toEqual(["extraction.failed"]);
  }, 30_000);

  it("rolls back a first extraction that fails after the upsert", async () => {
    const { sessionId } = await seed("transcribed", "booked");
    const outcome = await runExtraction(
      sessionId,
      deps({
        hooks: {
          afterUpsert: () => {
            throw new Error("injected failure after upsert");
          },
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: false, status: 502, details: "injected failure after upsert" });
    expect(await snapshot(sessionId)).toEqual([]);
    expect(await recording(sessionId)).toMatchObject({
      status: "transcribed",
      error: "injected failure after upsert",
      case_status: "booked",
    });
    expect(await audits(sessionId)).toEqual(["extraction.failed"]);
  }, 30_000);

  it("keeps a therapist decision made while the model was running", async () => {
    const { sessionId } = await seed("extracted");
    const outcome = await runExtraction(
      sessionId,
      deps({
        generate: async () => {
          await sql`update facts set value = '1'::jsonb, status = 'edited', confirmed_by = 'Demo Therapist'
                    where recording_id = ${sessionId} and item_id = '1'`;
          return rerun;
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    const facts = await snapshot(sessionId);
    expect(facts[0]).toMatchObject({ item_id: "1", value: 1, status: "edited" });
    // Other suggested items were refreshed but kept their first AI value.
    const item3 = facts.find((f) => f.item_id === "3")!;
    expect(item3).toMatchObject({ value: 4, ai_value: 3, status: "suggested" });
    // Voice-note items confirmed by the seed stay as they were.
    expect(facts.find((f) => f.item_id === "5")).toMatchObject({ value: 4, status: "confirmed", source: "therapist_voice" });
    expect(await recording(sessionId)).toMatchObject({ status: "extracted", error: null });
    expect(await audits(sessionId)).toEqual(["extraction.completed"]);
  }, 30_000);

  it("a therapist decision racing the commit waits for the lock and is not overwritten", async () => {
    const { sessionId } = await seed("extracted");
    let therapist: Promise<unknown> | undefined;
    const outcome = await runExtraction(
      sessionId,
      deps({
        hooks: {
          afterUpsert: async () => {
            therapist = sql`update facts set value = '5'::jsonb, status = 'confirmed', confirmed_by = 'Demo Therapist'
                            where recording_id = ${sessionId} and item_id = '4'`.execute();
            await sleep(300);
          },
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    await therapist;
    const item4 = (await snapshot(sessionId)).find((f) => f.item_id === "4")!;
    expect(item4).toMatchObject({ value: 5, status: "confirmed" });
  }, 30_000);

  it("a second concurrent extraction is rejected with 409", async () => {
    const { sessionId } = await seed("transcribed");
    const slow = deps({
      generate: async () => {
        await sleep(500);
        return extract;
      },
    });
    const [a, b] = await Promise.all([runExtraction(sessionId, slow), sleep(100).then(() => runExtraction(sessionId, slow))]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, status: 409, error: "Extraction already running" });
    const facts = await snapshot(sessionId);
    expect(facts).toHaveLength(40);
    expect(facts.filter((f) => f.status === "confirmed").map((f) => f.item_id)).toEqual(["5", "24"]);
    expect(await audits(sessionId)).toEqual(["extraction.completed"]);
  }, 30_000);
});
