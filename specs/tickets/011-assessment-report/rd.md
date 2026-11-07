# 011: Draft assessment report

**Status:** draft
**Mode:** solo
**Runs:** waits for 002, 003, 004: needs `seed:demo -- --confirmed`, lib/scoring.ts and the Report tab placeholder

## Summary

After the therapist has confirmed ISAA items, CareThread drafts the assessment report from confirmed
facts only. Gemini writes the background, observations per domain and recommendations; the server
inserts every number (total, band, domain scores, red flags, suggested action) so the AI never computes
a score. The therapist edits the Markdown and marks it final.

## Functional requirements

- **FR-1** - Report tab `/cases/<id>/report` replaces the placeholder: a select labelled `Session`
  listing `Session <n>` for every `extracted` session (default: highest number). With no extracted
  session, or no confirmed/edited ISAA fact in the selected one: `Confirm ISAA items in a session first.`
  Otherwise a button `Generate draft report` (label `Regenerate draft` when a draft exists).
- **FR-2** - When a report exists for the selected session: a textarea labelled `Report (Markdown)`, a
  rendered preview (`react-markdown`), buttons `Save` (shows `Saved`) and `Mark final`. A final report
  shows the badge `Final`, a read-only textarea, and no Save/Mark final/Regenerate buttons.
- **FR-3** - `POST /api/sessions/:id/report`: 404 `{ error: "Session not found" }`; 422
  `{ error: "Confirm at least one ISAA item first" }` when the session has no confirmed/edited ISAA fact
  with a value; 409 `{ error: "Report is final" }` when its assessment report is `final`. Calls Gemini
  `generateJson({ task: "report", system: prompts/report.md, prompt, schema: ReportDraftSchema })` with
  only confirmed/edited facts (`<n>. <item text>: <rating label> - "<quote>" (<mm:ss>)`), case details
  and the brief summary if one exists. Upserts the `assessment` report for the recording (`content` =
  Gemini output, `content_md` = FR-4, `status` `draft`, `updated_at` now). Audit `report.drafted`.
  Returns 200 `{ report }`. Gemini failure -> 502 `{ error: "Report could not be generated" }`.
  Exports `maxDuration = 300`. Filter model output before saving: observation item IDs must reference
  confirmed/edited facts from this session; reject unsupported IDs or unsupported factual claims rather
  than presenting them as observed. Do not invent a quotation for a confirmed fact without evidence.
- **FR-4** - `lib/report/markdown.ts` `composeReportMarkdown({ caseRow, sessionNumber, date, draft,
  score, redFlags, recommendation, therapist })` returns:
  `# Assessment report - <child_alias>`, a line `Session <n> · <YYYY-MM-DD> · <therapist>`,
  `## Background` (draft.background), `## ISAA result` (`formatIsaaScore(score)`, then a table
  `| Domain | Score | Max |` from `score.by_domain`), `## Observations` (per domain with text:
  `### <domain name>`, the text and `(items <ids joined by ", ">)`), `## Red flags` (`- Lost speech` /
  `- Self-injury` or `- None`), `## Suggested next steps` (`- <recommendation.action>` then each
  `draft.recommendations` item), and the last line exactly
  `AI-drafted from confirmed observations. Reviewed and decided by <therapist>. This is not a diagnosis by AI.`
- **FR-5** - `PATCH /api/reports/:id` body `{ content_md?: string (1..50000 chars), status?: "final" }`:
  404 `{ error: "Report not found" }`; 422 `{ error: "Only assessment reports can be edited here" }` for
  other kinds; 409 `{ error: "Report is final" }` when already final. Saves, sets `updated_at`, audits
  `report.edited` / `report.finalized`, returns 200 `{ report }`.
- **FR-6** - `prompts/report.md` follows section 10: use only the confirmed observations given; never
  compute or mention a total score or band (the server adds them); no diagnosis words; up to 5
  recommendations.
- **FR-7** - `tests/report.test.ts` covers `composeReportMarkdown` (exact headings, numbers from the
  score object, provisional wording, red flags, footer line) with fixture `report.json`.

## Non-functional requirements

- **NFR-1** - The score numbers in `content_md` always equal `scoreIsaa` of the session's facts at
  generation time using only confirmed/edited facts. For a provisional score use `minimum_total`;
  domain scores are computed from only those facts (as `scoreIsaa` sums supplied values), and must be
  labelled as confirmed sums rather than totals. Never include `suggested_total` or unconfirmed
  ratings in the report or model prompt.
- **NFR-2** - In DEMO_MODE generation answers in < 5 s.

## Affected areas

- `app/cases/[id]/report/page.tsx` (changed: placeholder -> report UI)
- `components/report/ReportEditor.tsx`, `components/report/SessionSelect.tsx` (new)
- `app/api/sessions/[id]/report/route.ts`, `app/api/reports/[id]/route.ts` (new)
- `lib/report/markdown.ts`, `lib/queries/reports.ts`, `prompts/report.md` (new)
- `tests/report.test.ts` (new)

## Don't touch

- `lib/scoring.ts`, `lib/types.ts`, `lib/gemini.ts`, other case tabs, `supabase/migrations/**`, `package.json`

## Out of scope

- PDF export, the parent voice note (015), sharing the report (012 shares a referral packet instead).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Which facts feed the report | confirmed/edited only | AI documents, the clinician decides |
| D-2 | Who writes numbers | Server (`lib/scoring.ts`) | grill A-4 spirit: never trust the model for numbers |
| D-3 | Provisional score in the report | Allowed; uses the `at least` wording from `formatIsaaScore` | therapist may report before confirming all 40 |
| D-4 | Editing | Plain Markdown textarea | fastest; no rich-text editor |

## Open questions

None.
