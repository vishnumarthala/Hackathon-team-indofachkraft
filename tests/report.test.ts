import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportDraftSchema, type CaseRow, type FactRow, type RecordingRow, type ReportDraft, type ReportRow } from "@/lib/types";

const m = vi.hoisted(() => ({
  getRecording: vi.fn(),
  getCase: vi.fn(),
  listIsaaFacts: vi.fn(),
  getAssessmentReport: vi.fn(),
  getBriefSummary: vi.fn(),
  saveAssessmentDraft: vi.fn(),
  getReport: vi.fn(),
  updateDraftReport: vi.fn(),
  generateJson: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/queries/recordings", () => ({ getRecording: m.getRecording }));
vi.mock("@/lib/queries/cases", () => ({ getCase: m.getCase }));
vi.mock("@/lib/queries/reports", () => ({
  listIsaaFacts: m.listIsaaFacts,
  getAssessmentReport: m.getAssessmentReport,
  getBriefSummary: m.getBriefSummary,
  saveAssessmentDraft: m.saveAssessmentDraft,
  getReport: m.getReport,
  updateDraftReport: m.updateDraftReport,
}));
vi.mock("@/lib/gemini", () => ({ generateJson: m.generateJson }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));

import { POST as draftPOST } from "@/app/api/sessions/[id]/report/route";
import { PATCH as reportPATCH } from "@/app/api/reports/[id]/route";
import {
  ReportEditor,
  generateLabel,
  generateReport,
  patchReport,
  type EditorReport,
} from "@/components/report/ReportEditor";
import { sessionHref, sessionLabel } from "@/components/report/SessionSelect";
import {
  buildReportPrompt,
  computeReport,
  decidedFacts,
  factLine,
  filterDraft,
  reportSystemPrompt,
  type DecidedFact,
} from "@/lib/report/draft";
import { NO_OBSERVATIONS, PROVISIONAL_DOMAIN_NOTE, composeReportMarkdown, reportFooter } from "@/lib/report/markdown";
import { scoreIsaa } from "@/lib/scoring";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE: ReportDraft = ReportDraftSchema.parse(
  JSON.parse(readFileSync(path.join(ROOT, "demo/fixtures/gemini/report.json"), "utf8")),
);

const CASE: CaseRow = {
  id: "00000000-0000-4000-8000-0000000000c1",
  child_alias: "Ravi (synthetic)",
  child_age_months: 40,
  parent_alias: "Lakshmi (synthetic)",
  parent_email: null,
  parent_phone: null,
  language: "te",
  therapist_name: "Demo Therapist",
  facp_score: null,
  status: "in_assessment",
  intake_token: null,
  created_at: "2026-11-07T00:00:00Z",
};
const SESSION_ID = "00000000-0000-4000-8000-0000000000a1";
const REPORT_ID = "00000000-0000-4000-8000-0000000000b1";
const RECORDING = {
  id: SESSION_ID,
  case_id: CASE.id,
  kind: "session",
  session_number: 1,
  created_at: "2026-11-05T10:00:00Z",
} as RecordingRow;

let seq = 0;
function fact(item: number, value: number | null, status: FactRow["status"], quote?: string, verified = true): FactRow {
  return {
    id: `f${++seq}`,
    case_id: CASE.id,
    recording_id: SESSION_ID,
    instrument: "ISAA",
    item_id: String(item),
    value,
    ai_value: value,
    source: "session",
    evidence: quote
      ? { quote, segment_id: `s${item}`, start_sec: 60 + item, end_sec: 70 + item, recording_id: SESSION_ID, verified }
      : null,
    confidence: 0.8,
    rationale: null,
    status,
    confirmed_by: status === "suggested" ? null : "Demo Therapist",
    confirmed_at: null,
    created_at: "2026-11-05T10:00:00Z",
  };
}

// Items the fixture cites, all confirmed: 1,5,6,7,9 social; 15,16,18,20 speech; 24,25,28,29,30 behaviour; 31 sensory.
const FIXTURE_ITEMS: Record<number, number> = {
  1: 4, 5: 4, 6: 4, 7: 4, 9: 3, 15: 4, 16: 4, 18: 4, 20: 3, 24: 3, 25: 3, 28: 3, 29: 4, 30: 4, 31: 4,
};
function allConfirmedFacts(): FactRow[] {
  const rows: FactRow[] = [];
  for (let id = 1; id <= 40; id++) {
    const v = FIXTURE_ITEMS[id];
    rows.push(v ? fact(id, v, "confirmed", id === 5 ? "he does not turn when I call him" : undefined) : fact(id, 1, "edited"));
  }
  return rows;
}
// Two confirmed items (5, 24), plus suggested ratings that must never reach the report.
function partialFacts(): FactRow[] {
  return [
    fact(5, 4, "confirmed", "he does not turn when I call him"),
    fact(24, 4, "confirmed"),
    fact(15, 5, "suggested", "UNCONFIRMED QUOTE about words"),
    fact(29, 5, "suggested", "UNCONFIRMED hits his head"),
    fact(31, 5, "suggested"),
    fact(2, null, "suggested"),
  ];
}

const compose = (draft: ReportDraft, facts: DecidedFact[]) =>
  computeReport({ caseRow: CASE, sessionNumber: 1, date: "2026-11-05", facts, draft });

describe("composeReportMarkdown", () => {
  const facts = decidedFacts(allConfirmedFacts());
  const { draft } = filterDraft(FIXTURE, facts);
  const { content_md: md, score } = compose(draft, facts);
  const lines = md.trimEnd().split("\n");

  it("has the exact headings in order", () => {
    const headings = lines.filter((l) => l.startsWith("#"));
    expect(headings).toEqual([
      "# Assessment report - Ravi (synthetic)",
      "## Background",
      "## ISAA result",
      "## Observations",
      "### Social relationship and reciprocity",
      "### Speech-language and communication",
      "### Behaviour patterns",
      "### Sensory aspects",
      "## Red flags",
      "## Suggested next steps",
    ]);
    expect(lines[2]).toBe("Session 1 · 2026-11-05 · Demo Therapist");
  });

  it("takes every number from the score object", () => {
    const expectedTotal = Object.values(FIXTURE_ITEMS).reduce((a, b) => a + b, 0) + (40 - 15);
    expect(score.total).toBe(expectedTotal);
    expect(md).toContain(`ISAA total: ${expectedTotal} · Mild (70-106)`);
    expect(md).toContain("| Domain | Score | Max |");
    for (const d of score.by_domain) expect(md).toContain(`| ${d.name} | ${d.score} | ${d.max} |`);
    expect(md).toContain("| Social relationship and reciprocity | 23 | 45 |");
    expect(md).not.toContain(PROVISIONAL_DOMAIN_NOTE);
  });

  it("lists observations with their item ids and the background", () => {
    expect(md).toContain(FIXTURE.background);
    expect(md).toContain("(items 1, 5, 6, 7, 9)");
    expect(md).toContain("(items 31)");
  });

  it("lists red flags and next steps (server action first, then model recommendations)", () => {
    const flags = md.split("## Red flags")[1].split("##")[0];
    expect(flags.trim().split("\n")).toEqual(["- Lost speech", "- Self-injury"]);
    const steps = md.split("## Suggested next steps")[1].trim().split("\n");
    expect(steps[0]).toBe("- Referral to specialist (Phase 3)");
    expect(steps.slice(1, 6)).toEqual(FIXTURE.recommendations.map((r) => `- ${r}`));
  });

  it("ends with the exact footer line", () => {
    expect(lines.at(-1)).toBe(
      "AI-drafted from confirmed observations. Reviewed and decided by Demo Therapist. This is not a diagnosis by AI.",
    );
    expect(reportFooter("X")).toContain("Reviewed and decided by X.");
  });

  it("uses provisional wording and confirmed-only domain sums", () => {
    const partial = decidedFacts(partialFacts());
    const out = compose({ background: "B.", observations: [], recommendations: [] }, partial);
    expect(out.score.total).toBeNull();
    expect(out.content_md).toContain("ISAA total: at least 46 (provisional - 2 of 40 confirmed)");
    expect(out.content_md).toContain(PROVISIONAL_DOMAIN_NOTE);
    expect(out.content_md).toContain("| Social relationship and reciprocity | 4 | 45 |");
    expect(out.content_md).toContain("| Behaviour patterns | 4 | 35 |");
    expect(out.content_md).toContain("| Speech-language and communication | 0 | 45 |");
    expect(out.content_md).toContain("| Sensory aspects | 0 | 30 |");
    expect(out.content_md).toContain(NO_OBSERVATIONS);
    expect(out.content_md).toContain("## Red flags\n\n- None");
    expect(out.content_md).not.toContain("AI-suggested");
    // The all-facts score would include the suggested 5s; the report must not.
    const unfiltered = scoreIsaa(partialFacts().map((f) => ({ item_id: f.item_id, value: f.value as number | null, status: f.status })));
    expect(out.content_md).not.toContain(String(unfiltered.suggested_total));
  });

  it("can be called directly with a red-flag list and None", () => {
    const score = scoreIsaa([]);
    const md2 = composeReportMarkdown({
      caseRow: CASE,
      sessionNumber: 2,
      date: "2026-01-02",
      draft: { background: "Bg", observations: [], recommendations: ["Do x"] },
      score,
      redFlags: [{ type: "self_injury", source: "isaa_item", item_id: "29" }],
      recommendation: { action: "Act" },
      therapist: "T",
    });
    expect(md2).toContain("## Red flags\n\n- Self-injury\n");
    expect(md2).toContain("## Suggested next steps\n\n- Act\n- Do x\n");
    expect(md2).toContain("ISAA total: at least 40 (provisional - 0 of 40 confirmed)");
  });
});

describe("model prompt", () => {
  it("contains only confirmed/edited facts, without invented quotes", () => {
    const facts = decidedFacts(partialFacts());
    expect(facts.map((f) => f.item_id)).toEqual([5, 24]);
    const prompt = buildReportPrompt({ caseRow: CASE, sessionNumber: 1, facts, briefSummary: "Parent says words were lost." });
    expect(prompt).toContain('5. ');
    expect(prompt).toContain(': Mostly - "he does not turn when I call him" (01:05)');
    expect(prompt).toMatch(/24\. .*: Mostly \(no quote recorded\)/);
    expect(prompt).not.toContain("UNCONFIRMED");
    expect(prompt).not.toMatch(/^15\. /m);
    expect(prompt).not.toMatch(/^29\. /m);
    expect(prompt).not.toMatch(/^31\. /m);
    expect(prompt).not.toContain("Always");
    expect(prompt).toContain("Parent says words were lost.");
    expect(prompt).toContain("Ravi (synthetic)");
  });

  it("drops an unverified evidence quote", () => {
    const [f] = decidedFacts([fact(7, 3, "confirmed", "made up words", false)]);
    expect(factLine(f)).toMatch(/: Frequently \(no quote recorded\)$/);
  });

  it("system prompt forbids computing the total score or band", () => {
    const system = reportSystemPrompt();
    expect(system).toMatch(/never compute or mention a total score/i);
    expect(system).toMatch(/band/i);
    expect(system).toContain("You document; you never diagnose.");
    expect(system).toMatch(/up to 5 recommendations|up to 5/i);
  });
});

describe("filterDraft", () => {
  const facts = decidedFacts(partialFacts());

  it("rejects observations citing unconfirmed or out-of-domain item ids", () => {
    const { draft, rejected } = filterDraft(
      {
        background: "Ravi attended with his mother.",
        observations: [
          { domain_id: "social", text: "Did not turn to name.", item_ids: [5] },
          { domain_id: "social", text: "Plays alone.", item_ids: [5, 6] },
          { domain_id: "speech", text: "Lost words.", item_ids: [15] },
          { domain_id: "sensory", text: "Hand flapping.", item_ids: [24] },
          { domain_id: "behaviour", text: "No ids.", item_ids: [] },
          { domain_id: "behaviour", text: "Hand flapping seen twice.", item_ids: [24, 24] },
        ],
        recommendations: [],
      },
      facts,
    );
    expect(draft.observations).toEqual([
      { domain_id: "social", text: "Did not turn to name.", item_ids: [5] },
      { domain_id: "behaviour", text: "Hand flapping seen twice.", item_ids: [24] },
    ]);
    expect(rejected.observations).toBe(4);
  });

  it("rejects quotations without matching evidence and score claims", () => {
    const { draft, rejected } = filterDraft(
      {
        background: 'Ravi attended. The mother said "he hits his head". His total score is high.',
        observations: [
          { domain_id: "social", text: 'Mother: "he does not turn when I call him".', item_ids: [5] },
          { domain_id: "behaviour", text: 'Therapist noted "flaps hands all day".', item_ids: [24] },
        ],
        recommendations: ["Refer because the band is severe.", "Keep routines predictable.", 'Ask about "hits his head".'],
      },
      facts,
    );
    expect(draft.background).toBe("Ravi attended.");
    expect(draft.observations.map((o) => o.item_ids)).toEqual([[5]]);
    expect(draft.recommendations).toEqual(["Keep routines predictable."]);
    expect(rejected).toEqual({ observations: 1, recommendations: 2, background_sentences: 2 });
  });

  it("with only two confirmed items, none of the fixture's broader observations are presented as observed", () => {
    const { draft } = filterDraft(FIXTURE, facts);
    expect(draft.observations).toEqual([]);
    const md = compose(draft, facts).content_md;
    expect(md).not.toContain("lining up");
    expect(md).not.toContain("hitting his own head");
  });
});

// ------------------------------------------------------------------------------------------
// Routes

const draftCall = (id = SESSION_ID) => draftPOST(new Request(`http://x/api/sessions/${id}/report`, { method: "POST" }), { params: Promise.resolve({ id }) });
const patchCall = (body: unknown, id = REPORT_ID) =>
  reportPATCH(
    new Request(`http://x/api/reports/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
const actions = () => m.audit.mock.calls.map((c) => (c[0] as { action: string }).action);
const reportRow = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: REPORT_ID,
  case_id: CASE.id,
  recording_id: SESSION_ID,
  kind: "assessment",
  content: {},
  content_md: "# Draft",
  audio_path: null,
  status: "draft",
  created_at: "2026-11-05T10:00:00Z",
  updated_at: "2026-11-05T10:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.getRecording.mockResolvedValue(RECORDING);
  m.getCase.mockResolvedValue(CASE);
  m.getBriefSummary.mockResolvedValue(null);
  m.getAssessmentReport.mockResolvedValue(null);
  m.saveAssessmentDraft.mockImplementation(async (_ids, w) => ({ ok: true, report: reportRow({ content_md: w.content_md, content: w.content }) }));
});

describe("POST /api/sessions/:id/report", () => {
  it("404 for an unknown session or a non-session recording", async () => {
    m.getRecording.mockResolvedValueOnce(null);
    let res = await draftCall();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
    m.getRecording.mockResolvedValueOnce({ ...RECORDING, kind: "intake_call" });
    res = await draftCall();
    expect(res.status).toBe(404);
  });

  it("422 when no confirmed/edited ISAA fact has a value", async () => {
    m.listIsaaFacts.mockResolvedValue([fact(1, 4, "suggested"), fact(2, null, "suggested")]);
    const res = await draftCall();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Confirm at least one ISAA item first" });
    expect(m.generateJson).not.toHaveBeenCalled();
  });

  it("409 when the report is final, without calling Gemini", async () => {
    m.listIsaaFacts.mockResolvedValue(partialFacts());
    m.getAssessmentReport.mockResolvedValue(reportRow({ status: "final" }));
    const res = await draftCall();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Report is final" });
    expect(m.generateJson).not.toHaveBeenCalled();
  });

  it("409 when the report became final while generating", async () => {
    m.listIsaaFacts.mockResolvedValue(partialFacts());
    m.generateJson.mockResolvedValue(FIXTURE);
    m.saveAssessmentDraft.mockResolvedValue({ ok: false, final: true });
    const res = await draftCall();
    expect(res.status).toBe(409);
  });

  it("502 on Gemini failure; no draft created or overwritten", async () => {
    m.listIsaaFacts.mockResolvedValue(allConfirmedFacts());
    m.getAssessmentReport.mockResolvedValue(reportRow());
    m.generateJson.mockRejectedValue(new Error("Gemini request failed: overloaded"));
    const res = await draftCall();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Report could not be generated" });
    expect(m.saveAssessmentDraft).not.toHaveBeenCalled();
    expect(actions()).toEqual(["report.draft_failed"]);
  });

  it("200: calls Gemini with confirmed facts only, saves filtered content and server numbers, audits", async () => {
    m.listIsaaFacts.mockResolvedValue(partialFacts());
    m.getBriefSummary.mockResolvedValue("Brief summary text.");
    m.generateJson.mockResolvedValue({
      ...FIXTURE,
      observations: [...FIXTURE.observations, { domain_id: "social", text: "Did not turn to name.", item_ids: [5] }],
    });
    const res = await draftCall();
    expect(res.status).toBe(200);
    const { report } = await res.json();

    const req = m.generateJson.mock.calls[0][0];
    expect(req.task).toBe("report");
    expect(req.system).toBe(reportSystemPrompt());
    expect(req.schema).toBe(ReportDraftSchema);
    expect(req.prompt).toContain("Brief summary text.");
    expect(req.prompt).not.toContain("UNCONFIRMED");
    expect(req.prompt).not.toMatch(/^(15|29|31|2)\. /m);

    const [ids, write] = m.saveAssessmentDraft.mock.calls[0];
    expect(ids).toEqual({ caseId: CASE.id, recordingId: SESSION_ID });
    expect(write.content.observations).toEqual([{ domain_id: "social", text: "Did not turn to name.", item_ids: [5] }]);
    expect(write.content_md).toContain("ISAA total: at least 46 (provisional - 2 of 40 confirmed)");
    expect(write.content_md).toContain("Session 1 · 2026-11-05 · Demo Therapist");
    expect(write.content_md).not.toContain("hitting his own head");
    expect(report.content_md).toBe(write.content_md);
    expect(actions()).toEqual(["report.drafted"]);
    expect(m.audit.mock.calls[0][0].details).toMatchObject({ confirmed_items: 2, provisional: true });
  });
});

describe("PATCH /api/reports/:id", () => {
  it("404 for an unknown report", async () => {
    m.getReport.mockResolvedValue(null);
    const res = await patchCall({ status: "final" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Report not found" });
  });

  it("422 for other report kinds", async () => {
    m.getReport.mockResolvedValue(reportRow({ kind: "pre_session_brief" }));
    const res = await patchCall({ content_md: "x" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Only assessment reports can be edited here" });
  });

  it("409 when already final", async () => {
    m.getReport.mockResolvedValue(reportRow({ status: "final" }));
    const res = await patchCall({ content_md: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Report is final" });
    expect(m.updateDraftReport).not.toHaveBeenCalled();
  });

  it("400 for invalid bodies", async () => {
    m.getReport.mockResolvedValue(reportRow());
    for (const body of [{}, { content_md: "" }, { content_md: "x".repeat(50_001) }, { status: "draft" }, "not json"]) {
      const res = await patchCall(body);
      expect(res.status).toBe(400);
    }
    expect(m.updateDraftReport).not.toHaveBeenCalled();
  });

  it("saves edits and finalizes, with audits", async () => {
    m.getReport.mockResolvedValue(reportRow());
    m.updateDraftReport.mockImplementation(async (_id, patch) => reportRow(patch));
    let res = await patchCall({ content_md: "# Edited by therapist" });
    expect(res.status).toBe(200);
    expect((await res.json()).report.content_md).toBe("# Edited by therapist");
    res = await patchCall({ status: "final" });
    expect((await res.json()).report.status).toBe("final");
    expect(actions()).toEqual(["report.edited", "report.finalized"]);
  });

  it("409 when the row turned final between read and write", async () => {
    m.getReport.mockResolvedValue(reportRow());
    m.updateDraftReport.mockResolvedValue(null);
    const res = await patchCall({ status: "final" });
    expect(res.status).toBe(409);
    expect(m.audit).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------
// UI

describe("ReportEditor", () => {
  const html = (initialReport: EditorReport | null) =>
    renderToStaticMarkup(createElement(ReportEditor, { recordingId: SESSION_ID, initialReport }));

  it("shows Generate draft report without a report", () => {
    const out = html(null);
    expect(out).toContain("Generate draft report");
    expect(out).not.toContain("Report (Markdown)");
    expect(generateLabel(null)).toBe("Generate draft report");
  });

  it("shows the editor, preview and buttons for a draft", () => {
    const out = html({ id: REPORT_ID, content_md: "# Assessment report - Ravi\n\n| Domain | Score | Max |\n| --- | --- | --- |\n| A | 1 | 5 |", status: "draft" });
    expect(out).toContain("Regenerate draft");
    expect(out).toContain("Report (Markdown)");
    expect(out).toMatch(/>Save</);
    expect(out).toContain("Mark final");
    expect(out).toContain("<table");
    expect(out).not.toMatch(/>Final</);
  });

  it("final: badge, read-only textarea, no Save/Mark final/Regenerate", () => {
    const out = html({ id: REPORT_ID, content_md: "# Done", status: "final" });
    expect(out).toMatch(/>Final</);
    expect(out).toMatch(/<textarea[^>]*readOnly/i);
    expect(out).not.toMatch(/>Save</);
    expect(out).not.toContain("Mark final");
    expect(out).not.toContain("Regenerate");
  });

  it("generateReport / patchReport call the API and surface errors", async () => {
    const report = { id: REPORT_ID, content_md: "x", status: "draft" };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ report }), { status: 200 }));
    expect(await generateReport(fetchFn, SESSION_ID)).toEqual({ ok: true, report });
    expect(fetchFn).toHaveBeenCalledWith(`/api/sessions/${SESSION_ID}/report`, { method: "POST" });

    await patchReport(fetchFn, REPORT_ID, { status: "final" });
    expect(fetchFn.mock.calls[1]).toEqual([
      `/api/reports/${REPORT_ID}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"status":"final"}' },
    ]);

    const failing = vi.fn(async () => new Response(JSON.stringify({ error: "Report is final" }), { status: 409 }));
    expect(await patchReport(failing, REPORT_ID, { content_md: "y" })).toEqual({ ok: false, error: "Report is final" });
    const throwing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await generateReport(throwing, SESSION_ID)).toEqual({ ok: false, error: "Report could not be generated" });
  });

  it("session select helpers", () => {
    expect(sessionLabel({ id: "a", session_number: 3 })).toBe("Session 3");
    expect(sessionHref("/cases/c/report", "abc")).toBe("/cases/c/report?session=abc");
  });
});
