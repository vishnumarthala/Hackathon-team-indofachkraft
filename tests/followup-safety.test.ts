// Ticket 040 FR-2 / FR-3: safety of the follow-up agent. Pure checks (the shared red-flag classifier, the medicine and
// condition rules, the answer post-check) and database checks driving the real pipeline with a spy model: red flags
// bypass the model and are audited without the question text, dose-change questions get the fixed medicine answer,
// and the 30-questions-per-day limit is atomic (red flags still get through at the limit).
// Synthetic users/children via tests/helpers/world.ts; everything is removed afterwards.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyRedFlagText, TEXT_RED_FLAG_CODES } from "@/lib/clinical/red-flags";
import {
  answerSuggestsMedicineChange,
  DAILY_QUESTION_LIMIT,
  isDiagnosisQuestion,
  isMedicineChangeQuestion,
  MEDICINE_ANSWER,
  RED_FLAG_ANSWER,
  SUGGESTED_QUESTIONS,
} from "@/lib/followup/constants";
import { URGENT_MESSAGE } from "@/lib/screen/questions";
import { purgeTestAudit } from "./helpers/audit";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

describe("shared red-flag classifier (FR-3)", () => {
  const cases: [string, string][] = [
    ["My child is not breathing properly", "breathing"],
    ["She is struggling to breathe and her lips turned blue", "breathing"],
    ["He had a fit this morning, what do I do?", "seizure"],
    ["He is having a seizure", "seizure"],
    ["My son took too much of his medicine", "medicine_overdose"],
    ["She swallowed the whole bottle of syrup", "medicine_overdose"],
    ["I accidentally gave him a double dose", "medicine_overdose"],
    ["He fainted and is unresponsive", "unconscious"],
    ["She won't wake up", "unconscious"],
    ["My daughter says she wants to die", "suicidal"],
    ["He talks about killing himself", "suicidal"],
    ["He keeps banging his head on the wall", "self_injury"],
    ["She hurts herself on purpose", "self_injury"],
    ["Someone is hurting my child", "safety_concern"],
    ["He has stopped eating and drinking", "not_eating_drinking"],
    ["She has stopped talking, she used to say words", "skill_regression"],
    ["He lost the words he had", "skill_regression"],
  ];
  it.each(cases)("%s -> %s", (text, code) => {
    expect(classifyRedFlagText(text)).toBe(code);
  });

  it("covers the 033 codes plus medicine overdose, breathing, unconscious and suicidal", () => {
    expect(TEXT_RED_FLAG_CODES).toEqual(
      expect.arrayContaining(["skill_regression", "self_injury", "seizure", "breathing", "not_eating_drinking", "safety_concern", "medicine_overdose", "unconscious", "suicidal"]),
    );
    for (const code of TEXT_RED_FLAG_CODES) expect(cases.some(([, c]) => c === code), code).toBe(true);
  });

  it("ordinary plan questions are not red flags", () => {
    for (const q of [
      ...SUGGESTED_QUESTIONS,
      "My child is not eating vegetables, any tips from the plan?",
      "He is not talking much yet, what should we practise?",
      "Can I double the syrup dose?",
      "How many times a week is the breathing exercise?",
      "When is the next session?",
    ]) {
      expect(classifyRedFlagText(q), q).toBeNull();
    }
  });

  it("uses the 033 safety message word for word", () => {
    expect(RED_FLAG_ANSWER).toBe(URGENT_MESSAGE);
    expect(RED_FLAG_ANSWER).toMatch(/108/);
    expect(RED_FLAG_ANSWER).toMatch(/112/);
  });
});

describe("medicine and condition rules (FR-2)", () => {
  it("dose or medicine changes get the fixed medicine answer", () => {
    for (const q of [
      "Can I double the syrup dose?",
      "Should we stop the medicine now that he is better?",
      "Can I give her less of the tablet?",
      "Is it ok to skip the evening dose?",
      "Can I also give paracetamol?",
      "Can I give him melatonin?",
      "Can we increase the drops to 2 ml?",
    ]) {
      expect(isMedicineChangeQuestion(q), q).toBe(true);
    }
    expect(MEDICINE_ANSWER).toBe("Please don't change any medicine without talking to the prescriber.");
  });

  it("questions about how to follow the prescription are answered from it", () => {
    for (const q of ["How do I give the medicine?", "How many days is the syrup for?", "What should we practise this week?", "When is the next review?"]) {
      expect(isMedicineChangeQuestion(q), q).toBe(false);
    }
  });

  it("asking whether the child has a condition is never answered by the model", () => {
    expect(isDiagnosisQuestion("Does my child have autism?")).toBe(true);
    expect(isDiagnosisQuestion("Is he autistic?")).toBe(true);
    expect(isDiagnosisQuestion("What should we practise this week?")).toBe(false);
  });

  it("an answer that suggests changing a medicine is caught", () => {
    expect(answerSuggestsMedicineChange("You can double the syrup dose if the fever stays.")).toBe(true);
    expect(answerSuggestsMedicineChange("It is fine to stop the tablets after 3 days.")).toBe(true);
    expect(answerSuggestsMedicineChange("Give 5 ml of the syrup three times a day for 3 days.")).toBe(false);
  });
});

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

describe.skipIf(!enabled)("follow-up pipeline safety (database)", () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let guardian: TestUser;
  let childId: string;
  const model = vi.fn(async () => ({ found: false, answer: "unused", medical_advice: false, citations: [] }));

  const ask = async (question: string) => {
    const { answerQuestion } = await import("@/lib/followup/answer");
    const outcome = await answerQuestion({ guardianUserId: guardian.id, childId, question, channel: "text", generate: model });
    return { status: outcome.response.status, body: (await outcome.response.json()) as Record<string, unknown>, redFlag: outcome.redFlag };
  };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t040s");
    const owner = await world.user("owner", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    const org = await world.org(owner, "Centre");
    const kase = await world.kase(org);
    childId = kase.childId;
    const link = await world.link(childId, guardian);
    await world.grant(childId, guardian, link, ["ai_follow_up"]);
    session.user = { id: guardian.id, email: guardian.email };
  });

  afterAll(async () => {
    session.user = null;
    if (sql && childId) {
      await sql`delete from followup_questions where child_id = ${childId}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action like 'followup.%' and actor_user_id = ${guardian.id}`);
    }
    if (world) await world.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("E-2: a red-flag question bypasses the model, is not stored and is audited without its text", async () => {
    const question = "My child is not breathing properly";
    const res = await ask(question);
    expect(res).toMatchObject({ status: 200, redFlag: true, body: { safety: "red_flag", found: false, answer: URGENT_MESSAGE, citations: [] } });
    expect(model).not.toHaveBeenCalled();
    const stored = await sql`select 1 from followup_questions where child_id = ${childId}`;
    expect(stored).toHaveLength(0);
    const [row] = await sql<{ details: Record<string, unknown>; child_id: string; actor_user_id: string; actor_role: string }[]>`
      select details, child_id, actor_user_id, actor_role from audit_events
      where action = 'followup.red_flag' and actor_user_id = ${guardian.id} order by created_at desc limit 1`;
    expect(row).toMatchObject({ child_id: childId, actor_role: "guardian", details: { code: "breathing", channel: "text" } });
    expect(JSON.stringify(row.details)).not.toContain("breathing properly");
  });

  it("E-2: a dose-change question gets the fixed medicine answer without a model call", async () => {
    const res = await ask("Can I double the syrup dose?");
    expect(res).toMatchObject({ status: 200, body: { safety: "medical_advice", answer: MEDICINE_ANSWER, found: false, citations: [] } });
    expect(model).not.toHaveBeenCalled();
    const [row] = await sql`select question, answer, safety from followup_questions where child_id = ${childId}`;
    expect(row).toMatchObject({ question: "Can I double the syrup dose?", answer: MEDICINE_ANSWER, safety: "medical_advice" });
  });

  it("a model answer that suggests a dose change is replaced by the medicine answer", async () => {
    model.mockResolvedValueOnce({ found: true, answer: "You can double the syrup dose if needed.", medical_advice: false, citations: [] });
    // No shared documents -> the model is not even called; the not-found answer comes back.
    const res = await ask("How long should the syrup be given?");
    expect(model).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ found: false, answer: "I couldn't find that in your child's shared plans. Please ask your provider using Messages." });
    model.mockReset();
    const { resolveModelAnswer } = await import("@/lib/followup/model");
    const resolved = resolveModelAnswer({ found: true, answer: "You can double the syrup dose if needed.", medical_advice: false, citations: [] }, { text: "", citable: new Map() });
    expect(resolved).toMatchObject({ safety: "medical_advice", answer: MEDICINE_ANSWER });
  });

  it("FR-2: 30 questions per guardian per day (atomic); red flags still get through at the limit", async () => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from followup_questions where guardian_user_id = ${guardian.id}`;
    // Fill up to one below the limit, then race two requests for the last slot.
    for (let i = n; i < DAILY_QUESTION_LIMIT - 1; i++) {
      await sql`insert into followup_questions (child_id, guardian_user_id, question, answer) values (${childId}, ${guardian.id}, ${`Synthetic question ${i}`}, 'Synthetic answer')`;
    }
    const results = await Promise.all([ask("Where is the clinic?"), ask("Who is the therapist?")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from followup_questions where guardian_user_id = ${guardian.id}`;
    expect(total).toBe(DAILY_QUESTION_LIMIT);
    expect((await ask("Can I double the syrup dose?")).status).toBe(429);
    expect(await ask("He is having a seizure right now")).toMatchObject({ status: 200, body: { safety: "red_flag" } });
    // Questions older than 24 hours do not count.
    await sql`update followup_questions set created_at = now() - interval '25 hours' where guardian_user_id = ${guardian.id} and question like 'Synthetic question%'`;
    expect((await ask("Where is the clinic?")).status).toBe(200);
  });
});
