// Ticket 052: pure checks. FR-1 next-step priority table (one case per rule, several children at once), FR-6 journey
// steps, the practice streak, FR-3 bottom-nav matching, FR-4 case filters, FR-5 case default tab, the confirmation
// text steps (outbox template) and "no Coming soon left" in the catalogues.
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { FAMILY_BOTTOM_NAV, bottomNavActive } from "@/components/family/FamilyBottomNav";
import { caseHref, defaultCaseTab, isPastAssessment } from "@/lib/cases/default-tab";
import { filterCases, parseCaseFilter } from "@/lib/dashboard/cases-filter";
import { journeySteps, type JourneyInput } from "@/lib/family/journey";
import {
  NEXT_STEP_RULES,
  directionsUrl,
  pickNextStep,
  practiceStreak,
  visitDay,
  type ChildFact,
  type FamilyFacts,
  type PaymentFact,
  type VisitFact,
} from "@/lib/family/next-step";
import { flattenMessages } from "@/lib/i18n/review";
import { TEMPLATES } from "@/lib/notify/templates";

const TZ = "Asia/Kolkata";
// 2026-11-16 10:00 IST (a Monday).
const NOW = new Date("2026-11-16T04:30:00Z");
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString();

const home = (over: Partial<ChildFact["home"]> = {}): ChildFact["home"] => ({
  activities: 0,
  logged_today: false,
  behind: false,
  logs_this_week: 0,
  streak: 0,
  ...over,
});
const child = (id: string, over: Partial<ChildFact> = {}): ChildFact => ({ id, name: `Child ${id}`, date_of_birth: "2021-01-01", care_team: [], home: home(), ...over });
const visit = (id: string, childId: string, hours: number, over: Partial<VisitFact> = {}): VisitFact => ({
  id,
  child_id: childId,
  child_name: `Child ${childId}`,
  status: "confirmed",
  starts_at: at(hours),
  ends_at: at(hours + 1),
  provider_profile_id: "p1",
  provider_name: "Dr Rao (synthetic)",
  service_name: "Speech therapy",
  mode: "in_clinic",
  location_name: "Clinic",
  location_address: "Road 1, Hyderabad",
  lat: 17.41,
  lng: 78.44,
  clinic_time_zone: TZ,
  series_id: null,
  is_demo: false,
  fee_inr: 0,
  hold_expires_at: null,
  has_intake: false,
  intake_consent: false,
  attempt: null,
  meet_url: null,
  meet_status: null,
  ...over,
});
const facts = (over: Partial<FamilyFacts> = {}): FamilyFacts => ({
  children: [child("a"), child("b")],
  visits: [],
  payments: [],
  messages: { unread: 0, latest: null },
  updates: [],
  timeZone: TZ,
  ...over,
});
const balance = (childId: string, paise: number): PaymentFact => ({
  kind: "balance",
  child_id: childId,
  child_name: `Child ${childId}`,
  amount_paise: paise,
  org_name: "Centre",
  href: `/family/children/${childId}/payments`,
});

describe("FR-1 next step priority (pickNextStep)", () => {
  it("lists the rules in the ticket's order", () => {
    expect(NEXT_STEP_RULES).toEqual(["add_child", "permission", "intake", "pay", "visit", "practice", "message", "all_set"]);
  });

  it("1. no child linked -> add a child (clinic code / find a therapist), whatever else is known", () => {
    expect(pickNextStep(facts({ children: [], payments: [balance("a", 5000)] }), NOW)).toEqual({ rule: "add_child" });
  });

  it("2. a permission is needed for an upcoming intake -> Give permission on that child's page", () => {
    const step = pickNextStep(
      facts({
        visits: [visit("v1", "a", 72), visit("v2", "b", 200, { has_intake: true, intake_consent: false })],
        payments: [balance("a", 5000)],
      }),
      NOW,
    );
    expect(step).toMatchObject({ rule: "permission", child_id: "b", href: "/family/children/b#permissions" });
  });

  it("2. the earliest appointment wins when several children need permission", () => {
    const step = pickNextStep(
      facts({
        visits: [
          visit("v1", "a", 30, { has_intake: true }),
          visit("v2", "b", 60, { has_intake: true }),
        ],
      }),
      NOW,
    );
    expect(step).toMatchObject({ rule: "permission", child_id: "a" });
  });

  it("3. intake not done (permission given) -> Start the intake call with the appointment-scoped link", () => {
    const ready = pickNextStep(
      facts({ visits: [visit("v1", "b", 50, { has_intake: true, intake_consent: true, attempt: { id: "t1", status: "issued", path: "/intake/a/TOKEN" } })] }),
      NOW,
    );
    expect(ready).toMatchObject({ rule: "intake", href: "/intake/a/TOKEN", ready: true, child_id: "b" });
    // Consent just given, link not issued yet (outbox) -> the visit page explains it is on its way.
    const pending = pickNextStep(facts({ visits: [visit("v1", "b", 50, { has_intake: true, intake_consent: true })] }), NOW);
    expect(pending).toMatchObject({ rule: "intake", href: "/family/appointments/v1", ready: false });
  });

  it("3. a completed intake is not a next step", () => {
    const step = pickNextStep(
      facts({ visits: [visit("v1", "a", 50, { has_intake: true, intake_consent: true, attempt: { id: "t1", status: "completed", path: null } })] }),
      NOW,
    );
    expect(step.rule).toBe("all_set");
  });

  it("4. balance due or unpaid package -> Pay; an expiring booking hold comes first, then the biggest balance", () => {
    const hold: PaymentFact = { kind: "appointment", child_id: "a", child_name: "Child a", amount_paise: 50000, org_name: null, href: "/book/p1/pay/v9" };
    expect(pickNextStep(facts({ payments: [balance("b", 120000), hold] }), NOW)).toMatchObject({ rule: "pay", payment: { kind: "appointment" } });
    expect(pickNextStep(facts({ payments: [balance("a", 10000), balance("b", 90000)] }), NOW)).toMatchObject({
      rule: "pay",
      payment: { child_id: "b", amount_paise: 90000 },
    });
  });

  it("5. a visit today or tomorrow -> the visit card (pay outranks it)", () => {
    expect(pickNextStep(facts({ visits: [visit("v1", "a", 3)] }), NOW)).toMatchObject({ rule: "visit", day: "today" });
    expect(pickNextStep(facts({ visits: [visit("v1", "a", 24)] }), NOW)).toMatchObject({ rule: "visit", day: "tomorrow" });
    expect(pickNextStep(facts({ visits: [visit("v1", "a", -0.5)] }), NOW)).toMatchObject({ rule: "visit", day: "now" });
    expect(pickNextStep(facts({ visits: [visit("v1", "a", 3)], payments: [balance("a", 500)] }), NOW).rule).toBe("pay");
    // In three days: not a "visit" step.
    expect(pickNextStep(facts({ visits: [visit("v1", "a", 72)] }), NOW)).toMatchObject({ rule: "all_set", next_visit: { id: "v1" } });
  });

  it("6. home activities not logged today and behind this week -> Log today's practice", () => {
    const step = pickNextStep(
      facts({
        children: [
          child("a", { home: home({ activities: 2, logged_today: true, behind: true }) }),
          child("b", { home: home({ activities: 1, logged_today: false, behind: true }) }),
        ],
        visits: [visit("v1", "a", 72)],
      }),
      NOW,
    );
    expect(step).toMatchObject({ rule: "practice", child_id: "b", href: "/family/children/b/home-program" });
    // Weekly target met -> nothing to nag about.
    expect(pickNextStep(facts({ children: [child("a", { home: home({ activities: 1, behind: false }) })] }), NOW).rule).toBe("all_set");
  });

  it("7. unread messages -> Read message from <therapist>", () => {
    const step = pickNextStep(facts({ messages: { unread: 3, latest: { thread_id: "t1", child_id: "a", unread: 2, from: "Dr Rao" } } }), NOW);
    expect(step).toEqual({ rule: "message", thread_id: "t1", from: "Dr Rao", unread: 3, href: "/family/messages/t1" });
  });

  it("8. otherwise -> You're all set, with the next visit (or none)", () => {
    expect(pickNextStep(facts(), NOW)).toEqual({ rule: "all_set", next_visit: null });
    // A payment hold is not a "next visit".
    const held = visit("v0", "a", 80, { status: "pending_payment" });
    expect(pickNextStep(facts({ visits: [held, visit("v1", "b", 100)] }), NOW)).toMatchObject({ rule: "all_set", next_visit: { id: "v1" } });
  });
});

describe("helpers", () => {
  it("visitDay uses the viewer's zone (23:30 IST is still today)", () => {
    const late = { starts_at: "2026-11-16T18:00:00Z", ends_at: "2026-11-16T18:30:00Z" }; // 23:30 IST
    expect(visitDay(late, TZ, NOW)).toBe("today");
    expect(visitDay(late, "UTC", NOW)).toBe("today");
    expect(visitDay({ starts_at: "2026-11-17T18:31:00Z", ends_at: "2026-11-17T19:00:00Z" }, TZ, NOW)).toBeNull(); // 00:01 IST on the 18th
  });

  it("practiceStreak counts back from today, or from yesterday while today is open", () => {
    expect(practiceStreak(["2026-11-16", "2026-11-15", "2026-11-14", "2026-11-12"], "2026-11-16")).toBe(3);
    expect(practiceStreak(["2026-11-15", "2026-11-14"], "2026-11-16")).toBe(2);
    expect(practiceStreak(["2026-11-13"], "2026-11-16")).toBe(0);
  });

  it("directions: coordinates first, then the address; none for video", () => {
    expect(directionsUrl(visit("v", "a", 1))).toBe("https://www.google.com/maps/dir/?api=1&destination=17.41%2C78.44");
    expect(directionsUrl(visit("v", "a", 1, { lat: null, lng: null }))).toContain("destination=Clinic%2C%20Road%201%2C%20Hyderabad");
    expect(directionsUrl(visit("v", "a", 1, { mode: "video" }))).toBeNull();
  });
});

describe("FR-6 what happens next (journeySteps)", () => {
  const base = (over: Partial<JourneyInput> = {}, appt: Partial<JourneyInput["appointment"]> = {}): JourneyInput => ({
    appointment: {
      id: "v1",
      status: "confirmed",
      starts_at: at(72),
      ends_at: at(73),
      attendance: null,
      provider_profile_id: "p1",
      child_id: "c1",
      mode: "in_clinic",
      has_intake: true,
      ...appt,
    },
    intake_consent: false,
    attempt: null,
    home_program: false,
    timeZone: TZ,
    ...over,
  });
  const view = (input: JourneyInput, now = NOW) => journeySteps(input, now).map((s) => [s.key, s.status, s.action?.href ?? null]);

  it("before the first visit: permission due, intake waiting for it, visit later, home program after the visit", () => {
    expect(view(base())).toEqual([
      ["permissions", "due", "/family/children/c1#permissions"],
      ["intake", "waiting", null],
      ["visit", "upcoming", null],
      ["home", "upcoming", null],
    ]);
  });

  it("after permission: the intake call is the action", () => {
    const steps = view(base({ intake_consent: true, attempt: { id: "t", status: "issued", path: "/intake/a/TOKEN" } }));
    expect(steps[0]).toEqual(["permissions", "done", "/family/children/c1#permissions"]);
    expect(steps[1]).toEqual(["intake", "due", "/intake/a/TOKEN"]);
  });

  it("no intake service: three steps, nothing needed before the visit", () => {
    const steps = journeySteps(base({}, { has_intake: false, starts_at: at(3), ends_at: at(4) }), NOW);
    expect(steps.map((s) => s.key)).toEqual(["permissions", "visit", "home"]);
    expect(steps[0]).toMatchObject({ status: "done", detail: "notNeeded" });
    expect(steps[1]).toMatchObject({ status: "due", detail: "today" });
  });

  it("after an attended visit with a published home program: home program due", () => {
    const steps = view(base({ intake_consent: true, attempt: { id: "t", status: "completed", path: null }, home_program: true }, { starts_at: at(-30), ends_at: at(-29), status: "completed", attendance: "present" }));
    expect(steps).toEqual([
      ["permissions", "done", "/family/children/c1#permissions"],
      ["intake", "done", null],
      ["visit", "done", null],
      ["home", "due", "/family/children/c1/home-program"],
    ]);
  });

  it("waiting for payment: the visit step asks to pay; cancelled: steps are skipped", () => {
    expect(view(base({}, { status: "pending_payment", has_intake: false }))[1]).toEqual(["visit", "due", "/book/p1/pay/v1"]);
    const cancelled = view(base({}, { status: "cancelled" }));
    expect(cancelled.map((s) => s[1])).toEqual(["done", "skipped", "skipped", "skipped"]);
  });
});

describe("FR-3 bottom nav", () => {
  it("has the five Figma items and marks one active", () => {
    expect(FAMILY_BOTTOM_NAV.map((i) => i.key)).toEqual(["home", "children", "visits", "messages", "account"]);
    const active = (p: string) => FAMILY_BOTTOM_NAV.filter((i) => bottomNavActive(p, i)).map((i) => i.key);
    expect(active("/family")).toEqual(["home"]);
    expect(active("/family/children/x/plan")).toEqual(["children"]);
    expect(active("/family/assessments")).toEqual(["children"]);
    expect(active("/family/appointments/x")).toEqual(["visits"]);
    expect(active("/family/messages/t")).toEqual(["messages"]);
    expect(active("/family/settings")).toEqual(["account"]);
  });
});

describe("FR-4 / FR-5 provider helpers", () => {
  const rows = [
    { id: "1", status: "booked", child_alias: "Ravi", parent_alias: "Lakshmi" },
    { id: "2", status: "intake_done", child_alias: "Anu", parent_alias: "Kiran" },
    { id: "3", status: "in_assessment", child_alias: "Bala", parent_alias: "Ravi's mum" },
    { id: "4", status: "referred", child_alias: "Chitra", parent_alias: "Devi" },
  ] as const;
  it("filter chips and search", () => {
    const ids = (f: string, q = "") => filterCases([...rows], parseCaseFilter(f), q).map((r) => r.id);
    expect(ids("all")).toEqual(["1", "2", "3", "4"]);
    expect(ids("review")).toEqual(["2", "3"]);
    expect(ids("booked")).toEqual(["1"]);
    expect(ids("referred")).toEqual(["4"]);
    expect(ids("nonsense")).toEqual(["1", "2", "3", "4"]);
    expect(ids("all", "ravi")).toEqual(["1", "3"]);
  });

  it("case default tab: Overview while in assessment, Sessions after it", () => {
    const facts = { status: "in_assessment", final_assessment: false, plan: false, series: false };
    expect(defaultCaseTab(facts)).toBe("overview");
    expect(caseHref("c1", defaultCaseTab(facts))).toBe("/cases/c1");
    for (const past of [{ status: "referred" }, { final_assessment: true }, { plan: true }, { series: true }]) {
      expect(isPastAssessment({ ...facts, ...past })).toBe(true);
      expect(caseHref("c1", defaultCaseTab({ ...facts, ...past }))).toBe("/cases/c1/sessions");
    }
  });
});

describe("FR-6 confirmation text (outbox)", () => {
  const payload = {
    appointment_id: "00000000-0000-4000-8000-000000000001",
    starts_at: "2026-11-20T05:00:00Z",
    ends_at: "2026-11-20T05:30:00Z",
    provider_name: "Dr Synthetic Rao",
    mode: "in_clinic",
    time_zone: TZ,
    location: "Synthetic Clinic",
  };
  const render = (role: "guardian" | "provider", p: Record<string, unknown>, locale: "en" | "hi" | "te" = "en") =>
    TEMPLATES.appointment_confirmed.render({
      payload: p as never,
      locale,
      role,
      appUrl: "http://localhost",
      event: { id: "1", aggregate_type: "appointment", aggregate_id: payload.appointment_id },
    });

  it("guardians get the numbered steps (with the intake call only when the service has one); providers do not", () => {
    const plain = render("guardian", payload);
    expect(plain.body).toContain("What happens next: 1. Permissions: check them in your DoctorNearMe app. 2. Visit: 20 Nov 2026, 10:30 am IST. 3. Home program:");
    expect(plain.email?.text).toContain("What happens next:");
    const intake = render("guardian", { ...payload, intake: { status: "consent_needed", agent_kind: "child_dev" } });
    expect(intake.body).toContain("1. Permissions: check them in your DoctorNearMe app. 2. Intake call: a short voice call before the visit. 3. Visit:");
    expect(render("provider", payload).body).not.toContain("What happens next");
    expect(render("guardian", payload, "hi").body).toContain("आगे क्या होगा:");
    expect(render("guardian", payload, "te").body).toContain("తర్వాత ఏమి జరుగుతుంది:");
  });
});

describe("catalogues", () => {
  it("no 'Coming soon' left in messages/*.json", () => {
    for (const catalogue of [en, hi, te]) {
      for (const [key, value] of Object.entries(flattenMessages(catalogue))) {
        expect(value, key).not.toMatch(/coming soon/i);
        expect(key, key).not.toMatch(/comingSoon/);
      }
    }
    // The old family home badge (`family.home.comingSoon`: "जल्द आ रहा है" / "త్వరలో వస్తుంది") is gone in every language.
    for (const catalogue of [en, hi, te]) expect(flattenMessages(catalogue)["family.home.comingSoon"]).toBeUndefined();
  });
});
