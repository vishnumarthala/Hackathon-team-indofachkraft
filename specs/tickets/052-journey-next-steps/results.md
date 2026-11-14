# 052: Clear next steps – family home, provider "Today", booking "what happens next" - Results

Branch: `ticket/052-journey-next-steps`. Tested against the isolated local Supabase stack of slot 2
(`supabase_db_dnmslot2`, all migrations of the branch base; this ticket adds **no migration**), `DEMO_MODE=true`,
dev server on the slot's port, headless browser at 390 px (family) and 1440 px (dashboard). Synthetic accounts and
data only. Design and data notes: [docs/next-steps.md](../../../docs/next-steps.md).

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0 |
| `npm run typecheck` | PASS | `next typegen && tsc --noEmit`, exit 0 |
| `npm run build` | PASS | exit 0 (pre-existing `lib/demo.ts` edge-import warnings only); new route `/family/appointments/[id]` |
| `npx vitest run` (DB suites running) | PASS | 109 files, 1859 passed, 11 skipped (opt-in only: `CT_DB_TESTS=1` intake-completion suite, live-crawl no-tracking) |
| `npx vitest run tests/next-step-*.test.ts tests/dashboard-today-*.test.ts` | PASS | 3 files, 37 tests ([evidence/vitest-052.txt](evidence/vitest-052.txt)) |
| Next-step priority table, one test per rule, several children | PASS | `tests/next-step-rules.test.ts` (pure `pickNextStep`, rules 1-8, multi-child tie-breaks) + `tests/next-step-family.test.ts` (DB: rules 2-7 from real rows) |
| Other guardians' children never appear (NFR-2) | PASS | `next-step-family` NFR-2 test; `/family/appointments/<other id>` → 404 |
| Provider Today counts per role / member sees own / other org none | PASS | `tests/dashboard-today-db.test.ts` (member, owner, admin, other org, no org) |
| Case default tab before/after assessment (FR-5) | PASS | `lib/cases/default-tab.ts`; unit + DB tests |
| No "Coming soon" in `messages/*.json` | PASS | test `catalogues > no 'Coming soon'`; `grep -c` = 0 in en/hi/te |
| NFR-1 < 800 ms with 50 children | PASS | fixed number of queries per card type; 50 children: family facts 4 ms, dashboard Today 4 ms (DB query time, local) |
| E-1 new parent | PASS | `Enter your clinic code` → `/family/children/claim`, `Find a therapist` → `/find`, both open; [e1-family-new-parent-390.png](evidence/e1-family-new-parent-390.png) |
| E-2 invited parent before the first visit | PASS | Next step `Give permission` → after `POST /api/.../consents` 201 and the outbox pass, `Start the intake call` (`/intake/a/<token>`); timeline `permissions:due → done`, `intake:waiting → due`; [e2-family-invited-parent-390.png](evidence/e2-family-invited-parent-390.png), [e2-family-after-permission-390.png](evidence/e2-family-after-permission-390.png), [e2-timeline-before-390.png](evidence/e2-timeline-before-390.png), [e2-timeline-after-390.png](evidence/e2-timeline-after-390.png) |
| E-3 mobile nav | PASS | 390 px: 5 items Home/Children/Visits/Messages/Account, badge `2` = unread, label "Messages, 2 unread messages", `aria-current` on Home, top nav hidden, safe-area padding |
| E-4 therapist morning | PASS | 4 sessions today, `1 note to write`, `2 ISAA items to confirm`; one-tap `Present` → DB present/completed, notes to write → 2, `Write note` → `/cases/<id>/sessions/new?appointment=<id>`; [e4-dashboard-1440.png](evidence/e4-dashboard-1440.png), [e4-dashboard-after-present-1440.png](evidence/e4-dashboard-after-present-1440.png) |
| FR-4 translated dashboard | PASS | hi: `आज` / `केस`; [fr4-dashboard-hi-1440.png](evidence/fr4-dashboard-hi-1440.png); te family home fits 390 px ([fr1-family-te-390.png](evidence/fr1-family-te-390.png)) |
| FR-6 confirmation + outbox text | PASS | `?booked=1` notice "Booked. Here is what happens next." + 4 steps; `appointment_confirmed` guardian text has numbered steps (intake step only when the service has one), provider text unchanged (`tests/notify-templates.test.ts`) |
| FR-7 empty states | PASS | children, visits, care-team updates, Today sessions, To do, case list each show one action |

Full browser run log: [evidence/acceptance.txt](evidence/acceptance.txt).

## Deviations

- WhatsApp: the in-app and email confirmations carry the "what happens next" steps now; the WhatsApp template
  bodies are listed in `docs/notifications.md` but need Meta re-approval before they can be sent (no real
  credentials locally; DEMO_MODE skips WhatsApp).
- `Invite parent` on the dashboard links to the case's parent-code panel (`#parent-code`) of cases without a parent
  account instead of a new invite dialog (existing 022/019 flow reused).
- The "From your care team" card shows guardian-visible published versions only (plan, note, home program,
  prescription); reports are not separately published to families yet.

## Notes

- New helpers: `lib/family/next-step.ts` (`loadFamilyFacts`, pure `pickNextStep`), `lib/family/journey.ts`
  (`loadAppointmentJourney`, `journeySteps`), `lib/dashboard/today.ts`, `lib/dashboard/cases-filter.ts`,
  `lib/cases/default-tab.ts`, `lib/cases/goal-summary.ts`; components `components/family/home/*`,
  `components/family/FamilyBottomNav.tsx`, `components/dashboard/*`. No new env vars, no schema change.
- Booking and payment flows now land on `/family/appointments/<id>?booked=1`.
- Pre-existing flakiness seen while running the whole suite in parallel (not in files this ticket touches):
  `outbox.test.ts` cron fan-out, `fees-flow`/`payments-flow` job assertions and one `booking-state-machine`
  deadlock each failed once in a full run and pass alone and on re-run; the final full run was green.
- 053 will migrate the remaining non-teal primary buttons; new UI here already uses `bg-teal-700 hover:bg-teal-800`.
