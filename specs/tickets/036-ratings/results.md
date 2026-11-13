# 036: Ratings for completed appointments - Results

Branch: `ticket/036-ratings` (base: `main` with 017-033, 038, 041; `main` with 034, 035, 037, 039 merged in before the
final checks). Tested against the isolated local Supabase stack of slot 6 (every migration applied by `db reset` after
the merge), `DEMO_MODE=true`, `CRON_SECRET=test-3060`, dev server on port 3060, `fetch` with per-user cookie jars and an
isolated headless Chrome (`playwright-core` in the git-ignored `.tmp/`, own browser context per user; not the shared
integrated browser). Accounts from `npm run -s seed:users -- --prefix e036`; synthetic data only. Raw evidence in
`evidence/` (`acceptance.txt` 46 checks, all PASS; `ui.txt` 23 checks, all PASS; `vitest-036-verbose.txt`; screenshots;
the two scripts as `accept-036.mts.txt` / `ui-036.mts.txt`).

| Check | Result | Evidence |
|-------|--------|----------|
| Migration `20261113003600_ratings.sql` (FR-1) | PASS | `ratings` (unique `appointment_id`, stars 1-5, comment <= 500, status `published`/`hidden`/`pending_review` default `published`, `created_at`, `edited_at`, `moderated_by`, `moderation_note`, plus `moderated_at`, `review_reason`, report columns); view `provider_rating_summary` over `published` only (`numeric(2,1)` average); insert trigger refuses ratings that are not the guardian's completed appointment of that provider; `search_providers` re-created with the same signature filling `rating_avg` (from 3 ratings) / `rating_count`; RLS on (guardians read own rows). `db reset` applies all 33 migrations |
| `npm run lint` / `npm run typecheck` | PASS | exit 0 / exit 0 (merged tree) |
| `npx vitest run` (slot 6, after `db reset`, merged tree) | PASS | 85 files, 1445 passed, 11 skipped (the pre-existing opt-in blocks: `CT_DB_TESTS=1` and the 041 live crawl). Every DB suite ran |
| `npm run build` | PASS | exit 0; new routes `/admin/ratings`, `/dashboard/ratings`, `/family/appointments/[id]/rate`, `/api/appointments/[id]/rating`, `/api/ratings/[id]/report`, `/api/admin/ratings/[id]` |
| `npx vitest run tests/ratings.test.ts --reporter=verbose` | PASS | 61 passed (`evidence/vitest-036-verbose.txt`): eligibility matrix (every status, owner/other/removed guardian, 30-day boundary, already rated), 7-day edit / hidden lock, comment screening (phones incl. `+91`, landline, Devanagari digits; emails incl. `[at]`/`[dot]`; `@handles`; URLs; child name parts in Latin, Devanagari and Telugu; sibling names; no false positives on ordinary text; abuse list -> review), summary view excludes hidden/pending, threshold display; DB: prompt trigger + fan-out re-check, 4.5 from 4, fresh provider `New`, 401/403/409/422, concurrent duplicates (one 201), 30-day window, PATCH rules, report/moderation/audit, NFR-1 views, fail-closed audit (503, nothing saved), DB trigger, privacy registry + account deletion |
| `tests/audit-hardening.test.ts` strict actions | PASS | `rating.created`, `rating.updated`, `rating.reported`, `rating.moderated` registered in `lib/audit/strict-actions.ts` (route calls the function; the function uses `.begin(` + `auditStrict(`) |
| E-1.1 rate prompt after completion | PASS | provider_a marks 5 appointments completed via `POST /api/appointments/:id/complete` -> `appointment.rate_prompt` pending, due in 120 min; nothing before; after time travel `outbox:run --once` -> guardian_a in-app `How was your visit?` / `Rate your visit with Dr Asha Rao (synthetic). Your rating is shown without your name.` linking `/family/appointments/<id>/rate`, email delivered (mock log) |
| E-1.1 ratings | PASS | guardian_a rates 5, 4, 5; guardian_b rates 4 -> 201 each, `published` |
| E-1.2 `/p/<slug>` | PASS | `4.5 ★ (4 ratings)` (aria-label `Rated 4.5 out of 5 from 4 ratings`), 3 comments each `✓ Verified booking · Nov 2026`; page contains no guardian email/id and no child name; directory API `rating_avg 4.5`, `rating_count 4` (`profile-ratings-375.png`); `/find` result cards render the same badge from these columns (not separately screenshotted) |
| E-1.3 fresh provider with 2 ratings | PASS | `New on DoctorNearMe` (`profile-new-375.png`); `search_providers` returns `rating_avg null`, `rating_count 2` |
| FR-5 `/family/appointments` | PASS | `Rate this visit` on the unrated completed visit, `You rated this visit 5 ★` (+ `Change rating` within 7 days) on rated ones (`family-appointments-rate-375.png`); rate form at 375 px: child's name -> `Please remove names and contact details from your comment.`, then saved (`rate-form-error-375.png`, `rate-form-saved-375.png`) |
| E-2 negatives | PASS | non-completed (confirmed) -> 403 `{"error":"You can rate only your completed appointments"}`; rate twice -> 409 `You already rated this visit`; guardian_b on guardian_a's appointment -> 403 (same body); `9876543210` -> 422 `{"error":"Please remove names and contact details from your comment"}`; child's name -> 422; anonymous -> 401; nothing saved |
| E-3 moderation | PASS | provider_b reporting provider_a's rating -> 404; provider_a reports -> 200 `pending_review`, comment gone from the profile, badge `4.7 ★ (3 ratings)`; provider_a on `POST /api/admin/ratings/:id` -> 403; `/admin/ratings` as provider -> 404; admin queue shows report reason + guardian email (`admin-ratings-queue.png`); hide without note -> 400; admin publishes -> visible again, `4.5 ★ (4 ratings)`; audit `rating.created/guardian`, `rating.reported/provider`, `rating.moderated/platform_admin`. Browser: provider `Report a rating` -> `Reported - under review` (`provider-reported-375.png`); admin `Hide` without note refused, `Publish` empties the queue |
| NFR-1 anonymous publicly | PASS | public comments return `{ id, comment, created_at }` only, rendered as month/year; provider page shows stars + month/year; guardian identity only on `/admin/ratings`; dev-server log of the whole run (92 lines): 0 matches for child names, guardian emails, the phone number or comment text |
| NFR-2 privacy registry | PASS | category `ratings` (before `appointments`): export = the requesting guardian's ratings of the child's appointments (other guardian: empty); erasure `everything` deletes them; deleting the guardian's account cascades; privacy notice `collect.ratings` + `retention.ratings` (en/hi/te); `docs/privacy/retention.md` |
| 375 px, translated, accessible | PASS | profile, family list, rate form, provider page at 375 px without horizontal scroll, no console errors (besides the expected 422 response); Telugu profile (`profile-ratings-te-375.png`); stars are a labelled radio group (`4 stars`), comment has label + hint + counter, errors `role="alert"`; all strings in en/hi/te (`ratings` namespace), `messages/REVIEW.md` regenerated, `i18n-keys` test green |

## Deviations

- **Completion time** comes from 030's append-only `appointment_events` (`appointment_completed_at()`), because the booking
  state machine is on the don't-touch list; the rate prompt is enqueued by an additive `after update of status` trigger on
  `appointments` in the completing transaction rather than inside `booking_complete`.
- **`search_providers` applies the display threshold**: `rating_avg` is null below 3 published ratings (so no consumer,
  e.g. the 034 voice agent, can present a small-sample average); `rating_count` is the published count, 0 when none (029's
  test expected null "until 036" and was updated).
- **Report flow**: the provider's report moves the rating to `pending_review` (as FR-6 says) and records `reported_by`,
  `reported_at`, `report_reason`; reporting an already-hidden rating -> 409; a rating already in review -> 200 unchanged.
  A guardian's edit keeps a reported rating in review; an edit that cleans an abuse-flagged comment publishes it.
- **Admins can also hide published ratings** (tabs `Published` / `Hidden` on `/admin/ratings`), not only the queue.
- **Erasure**: besides account deletion (NFR-2), an `everything` erasure of a child deletes the ratings of that child's
  appointments.
- **Not-eligible responses** are 403 for unknown ids and other guardians' appointments too (eval E-2 asks for 403, not
  404); the body is identical, so ids leak nothing.
- **`lib/i18n/translate.ts`**: adding this ticket's keys pushed `createTranslator` over TypeScript's instantiation depth
  (TS2589); main had the same fix by the time of the merge and main's version was kept.
- No provider-facing notification on new ratings and no admin notification on reports (queue count on `/admin/ratings`);
  noted as open questions in `docs/ratings.md`.

## Notes

- Abuse list and hi/te strings are first drafts; they need native review with `messages/REVIEW.md`.
- Strict audit actions added: `rating.created`, `rating.updated`, `rating.reported`, `rating.moderated` (comment text
  and notes are never written to the audit log).
- New outbox topic `appointment.rate_prompt` (in-app + email, template `rating_prompt`, no WhatsApp template).
- Docs: `docs/ratings.md` (new), `docs/system-design.md`, `docs/notifications.md`, `docs/maps.md`,
  `docs/privacy/retention.md`.
