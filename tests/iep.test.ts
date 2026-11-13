// Ticket 025 (FR-2, FR-4, FR-5, FR-7, NFR-2, NFR-3): pure checks of IEP validation per measure type, goalTrend,
// markdown rendering, the SVG chart and its `Show data` table, and client error mapping. The database suite
// (routes, publishing, authz) is tests/iep-access.test.ts. Synthetic data only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProgressChart, chartRange, chartXs } from "@/components/iep/ProgressChart";
import { iepErrorKey, sendJson, trendLines } from "@/components/iep/view";
import { createTranslator } from "@/lib/i18n/translate";
import { getMessages } from "@/lib/i18n/messages";
import { createFormatter } from "@/lib/i18n/format";
import { escapeMarkdown, formatMeasureValue, iepPlanMarkdown, orderGoals, type MarkdownGoal } from "@/lib/iep/markdown";
import { goalTrend } from "@/lib/iep/progress";
import {
  GoalCreateSchema,
  GoalPatchSchema,
  MSG,
  PlanCreateSchema,
  PlanPatchSchema,
  addMonths,
  makeProgressSchema,
  planDatesError,
  targetDateInPlan,
  todayInIndia,
  valueInRange,
} from "@/lib/iep/schema";
import { withI18n } from "./helpers/i18n";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const goalBody = (overrides: Record<string, unknown> = {}) => ({
  domain: "communication",
  statement: "Asha will request 5 preferred items using 2-word phrases",
  specific: "Requests snacks and toys with 2-word phrases",
  measurable: "Count of independent requests per session",
  achievable: "Uses single words for 3 items today",
  relevant: "Reduces frustration at home and school",
  time_bound: "Within 3 months, checked weekly",
  measure_type: "count",
  baseline_value: 1,
  target_value: 5,
  target_date: "2027-02-13",
  version: 1,
  ...overrides,
});

describe("FR-2 validation", () => {
  it("value ranges by measure type", () => {
    expect([0, 55.5, 100].every((v) => valueInRange("percent", v))).toBe(true);
    expect([-1, 100.1].some((v) => valueInRange("percent", v))).toBe(false);
    expect([1, 3, 5, 2.5].every((v) => valueInRange("rating_1_5", v))).toBe(true);
    expect([0, 5.5].some((v) => valueInRange("rating_1_5", v))).toBe(false);
    expect([0, 1].every((v) => valueInRange("yes_no", v))).toBe(true);
    expect([0.5, 2, -1].some((v) => valueInRange("yes_no", v))).toBe(false);
    expect([0, 3, 1000].every((v) => valueInRange("count", v))).toBe(true);
    expect(valueInRange("count", -1)).toBe(false);
    expect(valueInRange("count", Number.NaN)).toBe(false);
  });

  it("all five SMART fields are required (3-300 characters)", () => {
    expect(GoalCreateSchema.safeParse(goalBody()).success).toBe(true);
    for (const field of ["specific", "measurable", "achievable", "relevant", "time_bound"]) {
      const missing = { ...goalBody() } as Record<string, unknown>;
      delete missing[field];
      const r = GoalCreateSchema.safeParse(missing);
      expect(r.success, field).toBe(false);
      expect(r.error?.issues[0].path, field).toEqual([field]);
      expect(GoalCreateSchema.safeParse(goalBody({ [field]: "  " })).success, `${field} blank`).toBe(false);
      expect(GoalCreateSchema.safeParse(goalBody({ [field]: "x".repeat(301) })).success, `${field} long`).toBe(false);
    }
    expect(GoalCreateSchema.safeParse(goalBody({ statement: "too short" })).success).toBe(false);
  });

  it("baseline and target must fit the measure and differ", () => {
    const issues = (o: Record<string, unknown>) => GoalCreateSchema.safeParse(goalBody(o)).error?.issues.map((i) => i.path[0]) ?? [];
    expect(issues({ measure_type: "percent", baseline_value: 20, target_value: 80 })).toEqual([]);
    expect(issues({ measure_type: "percent", baseline_value: 20, target_value: 120 })).toEqual(["target_value"]);
    expect(issues({ measure_type: "rating_1_5", baseline_value: 0, target_value: 4 })).toEqual(["baseline_value"]);
    expect(issues({ measure_type: "yes_no", baseline_value: 0, target_value: 1 })).toEqual([]);
    expect(issues({ measure_type: "yes_no", baseline_value: 0, target_value: 0.5 })).toEqual(["target_value"]);
    expect(issues({ measure_type: "count", baseline_value: -2, target_value: 4 })).toEqual(["baseline_value"]);
    expect(issues({ baseline_value: 3, target_value: 3 })).toEqual(["target_value"]);
    // decreasing targets are fine (fewer meltdowns)
    expect(issues({ baseline_value: 10, target_value: 2 })).toEqual([]);
    expect(issues({ domain: "music" })).toEqual(["domain"]);
    expect(GoalCreateSchema.safeParse({ ...goalBody(), extra: 1 }).success).toBe(false);
    expect(GoalCreateSchema.safeParse({ ...goalBody(), version: undefined }).success).toBe(false);
  });

  it("plan dates: review on/after start and within 12 months; target date inside the plan", () => {
    expect(PlanCreateSchema.safeParse({ title: "Term 1", start_date: "2026-11-13", review_date: "2027-11-13" }).success).toBe(true);
    expect(PlanCreateSchema.safeParse({ title: "Term 1", start_date: "2026-11-13", review_date: "2027-11-14" }).success).toBe(false);
    expect(PlanCreateSchema.safeParse({ title: "Term 1", start_date: "2026-11-13", review_date: "2026-11-12" }).success).toBe(false);
    expect(PlanCreateSchema.safeParse({ title: "", start_date: "2026-11-13", review_date: "2027-01-13" }).success).toBe(false);
    expect(PlanCreateSchema.safeParse({ title: "x".repeat(121), start_date: "2026-11-13", review_date: "2027-01-13" }).success).toBe(false);
    expect(PlanCreateSchema.safeParse({ title: "T", start_date: "2026-02-30", review_date: "2026-05-01" }).success).toBe(false);
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2026-11-13", 12)).toBe("2027-11-13");
    expect(planDatesError("2027-02-29".replace("29", "28"), "2028-02-28")).toBeNull();
    const plan = { start_date: "2026-11-13", review_date: "2027-05-13" };
    expect(targetDateInPlan("2026-11-13", plan)).toBe(true);
    expect(targetDateInPlan("2027-05-13", plan)).toBe(true);
    expect(targetDateInPlan("2027-05-14", plan)).toBe(false);
    expect(targetDateInPlan("2026-11-12", plan)).toBe(false);
  });

  it("PATCH needs a version; status only completed/archived", () => {
    expect(PlanPatchSchema.safeParse({ title: "New" }).success).toBe(false);
    expect(PlanPatchSchema.safeParse({ title: "New", version: 2 }).success).toBe(true);
    expect(PlanPatchSchema.safeParse({ status: "active", version: 2 }).success).toBe(false);
    expect(PlanPatchSchema.safeParse({ status: "archived", version: 2 }).success).toBe(true);
    expect(GoalPatchSchema.safeParse({ statement: "Asha will ask for help", version: 3 }).success).toBe(true);
    expect(GoalPatchSchema.safeParse({ status: "paused", version: 3 }).success).toBe(false);
  });

  it("progress: no future dates (India), optional note up to 500", () => {
    const now = new Date("2026-11-13T20:00:00Z"); // 14 Nov in India
    expect(todayInIndia(now)).toBe("2026-11-14");
    const schema = makeProgressSchema(now);
    expect(schema.parse({ observed_on: "2026-11-14", value: 2 })).toEqual({ observed_on: "2026-11-14", value: 2, note: null });
    const future = schema.safeParse({ observed_on: "2026-11-15", value: 2 });
    expect(future.success).toBe(false);
    expect(future.error?.issues[0].message).toBe(MSG.futureDate);
    expect(schema.safeParse({ observed_on: "2026-11-01", value: 2, note: "x".repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ observed_on: "2026-11-01", value: "2" }).success).toBe(false);
  });
});

describe("FR-7 goalTrend", () => {
  const goal = { baseline_value: 1, target_value: 5 };
  const pts = (...values: number[]) => values.map((value, i) => ({ observed_on: `2026-11-${String(10 + i).padStart(2, "0")}`, value }));

  it("0 points: all null", () => {
    expect(goalTrend([], goal)).toEqual({ latest: null, change_from_baseline: null, percent_to_target: null, on_track: null });
  });

  it("1 point: values but no on_track", () => {
    expect(goalTrend(pts(2), goal)).toEqual({ latest: 2, change_from_baseline: 1, percent_to_target: 25, on_track: null });
  });

  it("2+ points: on track when moving towards the target (input order does not matter)", () => {
    expect(goalTrend(pts(1, 2, 3), goal)).toEqual({ latest: 3, change_from_baseline: 2, percent_to_target: 50, on_track: true });
    expect(goalTrend([...pts(1, 2, 3)].reverse(), goal).latest).toBe(3);
    expect(goalTrend(pts(3, 2), goal).on_track).toBe(false);
    expect(goalTrend(pts(2, 2), goal).on_track).toBe(false);
    // reached the target -> on track even when flat
    expect(goalTrend(pts(5, 5), goal)).toMatchObject({ percent_to_target: 100, on_track: true });
    // overshoot clamps to 100, regression below baseline clamps to 0
    expect(goalTrend(pts(4, 7), goal).percent_to_target).toBe(100);
    expect(goalTrend(pts(1, 0), goal)).toMatchObject({ change_from_baseline: -1, percent_to_target: 0, on_track: false });
  });

  it("decreasing targets (baseline 10 -> target 2)", () => {
    const down = { baseline_value: 10, target_value: 2 };
    expect(goalTrend(pts(9, 7, 6), down)).toEqual({ latest: 6, change_from_baseline: -4, percent_to_target: 50, on_track: true });
    expect(goalTrend(pts(6, 8), down).on_track).toBe(false);
    expect(goalTrend(pts(3, 2), down)).toMatchObject({ percent_to_target: 100, on_track: true });
  });

  it("uses the last 5 observations for the slope; same-day entries keep their recording order", () => {
    expect(goalTrend(pts(5, 4, 1, 2, 3, 4, 5).slice(0, 7), { baseline_value: 0, target_value: 10 }).on_track).toBe(true);
    const sameDay = [
      { observed_on: "2026-11-10", value: 3, created_at: "2026-11-10T05:00:00Z" },
      { observed_on: "2026-11-10", value: 2, created_at: "2026-11-10T04:00:00Z" },
    ];
    expect(goalTrend(sameDay, goal)).toMatchObject({ latest: 3, on_track: true });
  });
});

describe("FR-4 markdown", () => {
  const g = (o: Partial<MarkdownGoal>): MarkdownGoal => ({
    domain: "communication",
    statement: "Asha will request 5 preferred items using 2-word phrases",
    specific: "Requests with 2-word phrases",
    measurable: "Count per session",
    achievable: "Uses single words now",
    relevant: "Less frustration",
    time_bound: "Within 3 months",
    measure_type: "count",
    baseline_value: 1,
    target_value: 5,
    target_date: "2027-02-13",
    status: "active",
    sort: 0,
    ...o,
  });
  const plan = { title: "Asha Term 1", start_date: "2026-11-13", review_date: "2027-05-13" };

  it("title, dates, goals grouped by domain with SMART text and baseline -> target", () => {
    const md = iepPlanMarkdown(plan, [
      g({ domain: "social", statement: "Asha will take turns in a 2-player game", measure_type: "percent", baseline_value: 20, target_value: 80, sort: 0 }),
      g({ sort: 1 }),
      g({ domain: "behaviour", statement: "Asha will have fewer meltdowns per week", baseline_value: 6, target_value: 2, status: "achieved", sort: 2 }),
    ]);
    expect(md).toContain("# Asha Term 1");
    expect(md).toContain("Plan dates: 13 November 2026 to 13 May 2027 (review date).");
    const order = ["## Communication", "## Social", "## Behaviour"].map((h) => md.indexOf(h));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain("### Goal 1: Asha will request 5 preferred items using 2\\-word phrases".replace("\\-", "-"));
    expect(md).toContain("- **Measurable:** Count per session");
    expect(md).toContain("- **Time-bound:** Within 3 months");
    expect(md).toContain("- **Baseline to target:** 1 to 5 by 13 February 2027");
    expect(md).toContain("- **Baseline to target:** 20% to 80% by 13 February 2027");
    expect(md).toContain("Status: Achieved");
    expect(md.endsWith("\n")).toBe(true);
    expect(iepPlanMarkdown(plan, [])).toContain("No goals yet.");
  });

  it("provider text cannot change the document structure; plan status is not part of it", () => {
    expect(escapeMarkdown("# Heading\n- [link](x) *bold*")).toBe("\\# Heading - \\[link\\](x) \\*bold\\*");
    const md = iepPlanMarkdown({ ...plan, title: "## Not a heading" }, [g({ specific: "line one\n\n## injected" })]);
    expect(md).not.toMatch(/^## injected/m);
    expect(md).toMatch(/^# \\#\\# Not a heading$/m);
    expect(formatMeasureValue("rating_1_5", 3)).toBe("3 of 5");
    expect(formatMeasureValue("yes_no", 1)).toBe("Yes");
    expect(orderGoals([g({ domain: "academic", sort: 0 }), g({ domain: "communication", sort: 5 })]).map((x) => x.domain)).toEqual([
      "communication",
      "academic",
    ]);
  });
});

describe("chart and text (FR-5, FR-7, NFR-2, NFR-3)", () => {
  const labels = { title: "Progress chart: goal", baseline: "Baseline", target: "Target", showData: "Show data", date: "Date", value: "Value", noData: "None yet" };
  const points = [1, 2, 3].map((v, i) => ({ observed_on: `2026-11-1${i}`, value: v, dateLabel: `1${i} Nov`, valueLabel: String(v) }));
  const render = (extra: Partial<Parameters<typeof ProgressChart>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ProgressChart, { id: "c1", measure: "count", baseline: 1, target: 5, baselineLabel: "1", targetLabel: "5", points, labels, ...extra }),
    );

  it("SVG with 3 points, baseline and target lines, accessible name and a Show data table", () => {
    const html = render();
    expect(html.match(/<circle/g)).toHaveLength(3);
    expect(html).toContain('data-line="baseline"');
    expect(html).toContain('data-line="target"');
    expect(html).toContain('data-line="progress"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-labelledby="c1-title"');
    expect(html).toContain("<title id=\"c1-title\">Progress chart: goal</title>");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Show data<\/summary><table/);
    expect(html.match(/data-row-value=/g)).toHaveLength(3);
    expect(html).not.toContain("<th scope=\"col\" class=\"py-1 font-semibold\">Note"); // no notes column for guardians
  });

  it("no points: lines only and the empty text; ranges per measure", () => {
    const html = render({ points: [] });
    expect(html).not.toContain("<circle");
    expect(html).not.toContain("<details");
    expect(html).toContain("None yet");
    expect(chartRange("percent", [])).toEqual({ min: 0, max: 100 });
    expect(chartRange("rating_1_5", [])).toEqual({ min: 1, max: 5 });
    expect(chartRange("yes_no", [])).toEqual({ min: 0, max: 1 });
    expect(chartRange("count", [1, 5, 3]).max).toBeGreaterThanOrEqual(5);
    const xs = chartXs(["2026-11-01", "2026-11-11", "2026-11-21"]);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1]);
    expect(chartXs(["2026-11-01"])).toHaveLength(1);
  });

  it("trend text in en/hi/te, `On track` shown", () => {
    const trend = goalTrend(
      [1, 2, 3].map((value, i) => ({ observed_on: `2026-11-1${i}`, value })),
      { baseline_value: 1, target_value: 5 },
    );
    const lines = (locale: "en" | "hi" | "te") => {
      const t = createTranslator(locale, getMessages(locale), "iep.trend");
      return trendLines(t as never, (n) => String(n), createFormatter(locale, "Asia/Kolkata"), trend);
    };
    expect(lines("en")).toEqual(["Latest: 3", "Change from baseline: +2", "50% of the way to the target", "On track"]);
    expect(lines("te").join(" ")).toContain("సరైన దారిలో");
    expect(lines("hi").join(" ")).toContain("सही राह पर");
    const none = createTranslator("en", getMessages("en"), "iep.trend");
    expect(trendLines(none as never, String, createFormatter("en", "Asia/Kolkata"), goalTrend([], { baseline_value: 0, target_value: 1 }))).toEqual([
      "No progress recorded yet.",
    ]);
  });

  it("maps API errors (409 stale, field details) to translated keys", async () => {
    expect(iepErrorKey(MSG.stale)).toBe("stale");
    expect(iepErrorKey(MSG.futureDate)).toBe("futureDate");
    expect(iepErrorKey("Something else")).toBe("saveFailed");
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await sendJson(reply(409, { error: MSG.stale }), "/x", "PATCH", {})).toEqual({ ok: false, status: 409, error: "stale", fields: {} });
    expect(
      await sendJson(reply(400, { error: "Invalid request", details: { measurable: "Measurable is required", target_date: MSG.targetDateRange } }), "/x", "POST", {}),
    ).toEqual({ ok: false, status: 400, error: "targetDateRange", fields: { measurable: "smart", target_date: "targetDate" } });
    expect(await sendJson(reply(201, { goal: { id: "g" } }), "/x", "POST", {})).toEqual({ ok: true, data: { goal: { id: "g" } } });
  });
});

describe("provider Goals tab renders (FR-5, NFR-3)", async () => {
  const { GoalsPanel } = await import("@/components/iep/GoalsPanel");
  const plan = {
    id: "p1",
    case_id: "c1",
    child_id: "ch1",
    org_id: "o1",
    title: "Asha Term 1",
    start_date: "2026-11-13",
    review_date: "2027-05-13",
    status: "active" as const,
    version: 4,
    created_by: null,
    created_at: "2026-11-13T00:00:00Z",
    updated_at: "2026-11-13T00:00:00Z",
    goal_count: 1,
    published: { version: 1, published_at: "2026-11-13T05:00:00Z", published_by: null },
    has_unpublished_changes: true,
  };
  const goal = {
    ...goalBody(),
    id: "g1",
    plan_id: "p1",
    status: "active" as const,
    sort: 0,
    created_at: "",
    updated_at: "",
    domain: "communication" as const,
    measure_type: "count" as const,
    progress: [1, 2, 3].map((value, i) => ({
      id: `e${i}`,
      goal_id: "g1",
      recorded_by: null,
      observed_on: `2026-11-1${i}`,
      value,
      note: i === 0 ? "first try" : null,
      source: "manual" as const,
      recording_id: null,
      created_at: "",
    })),
    trend: goalTrend([1, 2, 3].map((value, i) => ({ observed_on: `2026-11-1${i}`, value })), { baseline_value: 1, target_value: 5 }),
  };
  const html = (locale: "en" | "te", p = plan) =>
    renderToStaticMarkup(withI18n(createElement(GoalsPanel, { caseId: "c1", plans: [p], plan: p, goals: [goal], today: "2026-11-13" }), locale));

  it("header with `Publish changes` + `Unpublished changes`, labelled Add goal fields, Record progress, chart", () => {
    const out = html("en");
    expect(out).toContain("Unpublished changes");
    expect(out).toContain("Publish changes");
    for (const label of ["Domain", "Goal", "Specific", "Measurable", "Achievable", "Relevant", "Time-bound", "How we measure", "Baseline", "Target", "Target date"]) {
      expect(out, label).toMatch(new RegExp(`<label for="[^"]+"[^>]*>${label}</label>`));
    }
    expect(out).toContain("Record progress");
    expect(out).toContain("On track");
    expect(out).toContain("Show data");
    expect(out).toContain("first try"); // providers see notes
    const draft = html("en", { ...plan, status: "draft" as never, published: null as never, has_unpublished_changes: false });
    expect(draft).toContain("Publish to parent");
    expect(draft).not.toContain("Unpublished changes");
  });

  it("Telugu chrome, goal text as written", () => {
    const out = html("te");
    expect(out).toContain("మార్పులను పంచుకోండి");
    expect(out).toContain("Asha will request 5 preferred items using 2-word phrases");
  });
});
