// Ticket 024 FR-2: report-kind registry. Pure, safe in the browser.
//
// `reports.kind` (DB check constraint) holds the three kinds in use today. Reserved kinds are claimed here so
// later tickets agree on names and audiences; the ticket that starts producing one extends the DB check in
// its own migration and flips nothing else.
// `audience` decides the guardian-visibility default when a report is published (published_versions,
// lib/clinical/publish.ts): only `guardian`/`both` kinds are published visible to the guardian by default.

export type ReportAudience = "provider" | "guardian" | "both";

export type ReportKindSpec = {
  audience: ReportAudience;
  /** Becomes a published version when final (reports with status `final`). */
  publishable: boolean;
  /** Who writes it: the ticket and the code path. */
  producer: string;
  /** false = reserved: not in the `reports.kind` DB check yet. */
  inUse: boolean;
};

export const REPORT_KINDS = {
  pre_session_brief: {
    audience: "provider",
    publishable: false,
    producer: "010 intake brief (lib/intake/process.ts)",
    inUse: true,
  },
  assessment: {
    audience: "provider",
    publishable: true,
    producer: "011 assessment report (app/api/sessions/[id]/report, finalised by PATCH /api/reports/:id)",
    inUse: true,
  },
  parent_summary: {
    audience: "guardian",
    publishable: true,
    producer: "015 parent voice note (app/api/reports/[id]/parent-voice-note)",
    inUse: true,
  },
  // 038: published by finalizeSessionNote (lib/scribe/notes.ts) with the clinician's visible_to_guardian choice
  // (default off), not by the reports_publish_final trigger.
  session_note: { audience: "provider", publishable: true, producer: "038 AI scribe (lib/scribe/run.ts)", inUse: true },
  rx_draft: { audience: "provider", publishable: false, producer: "038 AI scribe draft, signed by 039 e-prescription", inUse: true },
  generic_intake_brief: { audience: "provider", publishable: false, producer: "035 appointment intake", inUse: false },
} as const satisfies Record<string, ReportKindSpec>;

export type ReportKind = keyof typeof REPORT_KINDS;
export type ActiveReportKind = { [K in ReportKind]: (typeof REPORT_KINDS)[K]["inUse"] extends true ? K : never }[ReportKind];

export const REPORT_KIND_KEYS = Object.keys(REPORT_KINDS) as ReportKind[];

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REPORT_KINDS, value);
}

/** Guardian-visibility default of a newly published report of this kind (same rule as SQL reports_publish_final). */
export function defaultVisibleToGuardian(kind: ReportKind): boolean {
  return REPORT_KINDS[kind].audience !== "provider";
}
