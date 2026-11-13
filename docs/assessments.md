# Assessment portal (ticket 024)

Providers send questionnaires to a guardian of the case's child; the guardian answers in the family portal;
the provider reviews, scores and optionally shares a summary. Built on the clinical contracts in
`docs/system-design.md` section 7 ("Clinical contracts").

## Model

| Table | What |
|-------|------|
| `assessment_templates` | `instrument_key` -> `clinical_instruments`, `title`, `audience` (`guardian` / `provider`), `org_id` (null = global), `active`. Seeded: global `Parent developmental check-in` (`ISAA_PARENT_CHECKIN`, id `00000000-0000-4000-8024-000000000001`, `PARENT_CHECKIN_TEMPLATE_ID`). No template editor yet (out of scope). |
| `assessments` | `case_id`, `child_id`, `org_id` (copied from the case by a trigger), `template_id`, `assigned_to` (the guardian), `assigned_by`, `status` (`assigned` -> `in_progress` -> `submitted` -> `reviewed`, or `cancelled`), `due_on`, `submitted_at`, `score` (jsonb, computed by the server at submit), `reviewed_by/at`, `reviewer_note` (internal), `version` (optimistic concurrency, starts at 1). |
| `assessment_responses` | `(assessment_id, item_id)` -> `value` (jsonb), `answered_by`, `answered_at`. |

Every write is one transaction in `lib/assessments/index.ts` that locks the row and writes its audit event
(`assessment.assigned`, `.responses_saved`, `.red_flag`, `.submitted`, `.reviewed`, `.cancelled`) in the same
transaction. RLS (browser reads only): the assigned guardian with an active link and the case's care team
(`can_access_case`); no client writes.

## Access

- Providers: case access (022 rule). `requireCaseActor(caseId)` for `/api/cases/:id/assessments`,
  `requireAssessmentActor(assessmentId)` for `/api/assessments/:id/**`; other tenants' ids -> 404.
- Guardians: `requireGuardian()`, then only the **assigned** guardian with an **active link** to the live child
  (re-checked in every query; another guardian of the same child, a revoked link, other families -> 404).
- A questionnaire can only go to a guardian with an active link to the case's child (else 422
  `This parent is not linked to the child`). No consent feature gate: answers stay with the treating
  organisation and no AI processes them.

## API

| Route | Body | Answer |
|---|---|---|
| `GET /api/cases/:id/assessments` | - | 200 `{ assessments }` |
| `POST /api/cases/:id/assessments` | `{ template_id, assigned_to, due_on? }` (`YYYY-MM-DD`, today or later in India, within a year) | 201 `{ assessment }`; 422 not linked / unknown template; 409 the same questionnaire is already open for this parent |
| `GET /api/assessments/:id` | - | 200 `{ assessment, answers, score, red_flags, published }` (live partial score until submitted) |
| `POST /api/assessments/:id/review` | `{ note?, share_with_parent }` | 200 `{ assessment, published }`; 409 not submitted / already reviewed |
| `POST /api/assessments/:id/cancel` | - | 200; 409 not open |
| `PUT /api/family/assessments/:id/responses` | `{ answers: [{ item_id, value }], version }` | 200 `{ version, status, red_flags }`; 409 stale version / already submitted / cancelled; 400 unknown item or invalid value |
| `POST /api/family/assessments/:id/submit` | - | 200 `{ status, red_flags }`; 422 `{ error: "Please answer all questions", details: { missing } }`; 409 already submitted |

The guardian does not get the score at submit: the care team reviews first.

## Red flags

A red-flag question answered `yes` shows `Please contact your child's doctor now. In an emergency call 108
(ambulance) or 112.` immediately in the form, which saves at once. The server audits `assessment.red_flag`
and calls `notifyLater("assessment.red_flag", { assessment_id, case_id, codes })` once per newly raised code.
The provider list shows a red-flag badge and the detail page highlights the answers.

## Publishing and sharing

`Mark reviewed` publishes a summary with `publishVersion(tx, { entityType: "assessment", ... })` in the review
transaction: title, dates, the band's fixed copy (with the not-a-diagnosis sentence) and the red-flag
questions answered yes. Never the raw score breakdown or the reviewer's note. `Share result with parent`
sets `visible_to_guardian`; the guardian sees the summary on `/family/assessments/[id]`.

Share scope `assessments` (`lib/sharing/loaders/assessments.ts`): the current published summary of each
**reviewed** questionnaire of the source organisations' cases for the child.

## Notifications (ticket 032)

Topics in `lib/notify/topics.ts` (`ASSESSMENT_TOPICS`), only logged until 032 wires the outbox:
`assessment.assigned` (recipient: the guardian), `assessment.submitted` and `assessment.red_flag`
(recipients: the case's active care team, lead first). Payloads carry ids and red-flag codes only.

## UI

- Provider: case workspace `Assessments` tab (`app/cases/[id]/assessments`, `components/assessments/AssessmentsPanel.tsx`),
  detail `app/cases/[id]/assessments/[assessmentId]` (answers, score/band, red flags, `Mark reviewed`).
- Guardian: `/family/assessments` (nav `Questionnaires`) and `/family/assessments/[id]`
  (`components/assessments/CheckinForm.tsx`: one question per screen, `Save and continue later`, `Submit`).
  UI chrome is translated (en/hi/te); question text stays English (`lang="en"`) until a clinical
  translation review.

Tests: `tests/assessments.test.ts`, `tests/clinical-contracts.test.ts`.
