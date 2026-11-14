# Clear next steps (ticket 052)

Each role gets one obvious next action (Figma `/family — Home` 15:11 and `/dashboard — Cases` 18:11).

## Family home (`/family`)

`app/family/(portal)/page.tsx` renders, top to bottom:

1. Greeting `Namaste, <name>` and "Here is what's happening with <children> this week".
2. **One Next step card** (`components/family/home/NextStepCard.tsx`).
3. Your children: initials, age, care team (022, active members only), next visit, home-program streak.
4. Upcoming visits: the next 3 confirmed visits, weekly-series sessions (043) labelled `Weekly`.
5. From your care team: the latest guardian-visible published plan, session note, home program or prescription.
6. Quick links: Find a therapist (`/find`), Developmental check-in (`/screen`), Questionnaires, Documents.

Every list has an empty state with one action.

### Data: `lib/family/next-step.ts`

`loadFamilyFacts(userId, { timeZone })` runs a fixed set of queries (children, visits, balances, package offers,
home-program activities, practice logs, unread threads, care team, published versions), whatever the number of
children (NFR-1: 50 children load in a few ms locally). Scope (NFR-2):

- children: the guardian's **active** guardian links to live children;
- visits: appointments this guardian booked (`guardian_user_id`, as `/family/appointments`) for those children,
  confirmed and not yet ended, plus payment holds that are still open;
- money: `fees_balance` of the children's ledgers (045) from ₹1, unexpired package offers, open payment holds;
- messages: 027's `list_message_threads` (guardian-link gated).

`pickNextStep(facts, now)` is pure. Priority (FR-1), first match wins; with several children the earliest visit
(or the first child) wins inside a rule:

| # | Rule | Action |
|---|------|--------|
| 1 | No child linked | `Enter your clinic code` (`/family/children/claim`) + `Find a therapist` (`/find`) |
| 2 | An upcoming visit has an AI intake call and `ai_intake_call` is not allowed | `Give permission` → `/family/children/<id>#permissions` |
| 3 | Intake call not done (permission given) | `Start the intake call` → `/intake/a/<token>` (035); while the link is being issued, `Open the visit` |
| 4 | Payment hold, balance due or unpaid package offer | `Pay ₹X` → the checkout (holds) or the child's Payments page |
| 5 | A visit now, today or tomorrow (viewer's zone) | Visit card: time, place, `Join video` (037 join window), `Directions`, `What happens next` |
| 6 | Home activities (026) not logged today and a weekly target not met | `Log today's practice` |
| 7 | Unread messages | `Read message from <therapist>` |
| 8 | Otherwise | `You're all set` + the next visit (or `Find a therapist`) |

`practiceStreak` counts consecutive days with at least one log, ending today (or yesterday while today is open).

### Mobile bottom nav

`components/family/FamilyBottomNav.tsx` (client), below 640 px only: Home, Children, Visits, Messages, Account. It is
fixed, padded by `env(safe-area-inset-bottom)`, uses 56 px targets, `aria-current="page"` and puts the unread count
in the Messages link's label (`Messages, 2 unread messages`); the red badge shows the same number
(`familyUnreadCount`). Desktop keeps the top nav (`FamilyNav`). Questionnaires and Documents moved off the mobile nav:
they are linked from the child page and from Account (`/family/settings`); their routes did not change.
`app/family/layout.tsx` adds bottom padding to pages that render the nav (`has-[[data-bottom-nav]]`), so the
emergency line stays visible.

## What happens next (`/family/appointments/[id]`)

`lib/family/journey.ts`: `loadAppointmentJourney(userId, id, timeZone)` (booking guardian with an active link to
the child, else `null` → 404) and the pure `journeySteps(input, now)`:

| Step | Done | Due (action) | Otherwise |
|------|------|--------------|-----------|
| Permissions | `ai_intake_call` allowed, or the service has no intake call | `Give permission` | – |
| Intake call (only when the service has one) | completed | `Start the intake call` (link issued) | waiting for permission / link on its way; skipped after the visit |
| Visit | attended | today / tomorrow / now; `Pay now` while waiting for payment | later; missed / cancelled; "the centre will update this visit" |
| Home program | – | published and the visit attended: `Open home program` | "after the visit, your therapist shares activities" |

The booking flow (`components/booking/BookingFlow.tsx`) and the payment page (`PayPanel`) now land on
`/family/appointments/<id>?booked=1` (a "Booked" notice above the same page). The guardian's confirmation
(`appointment_confirmed`: in-app, email) appends the same steps in plain text (`NEXT_STEPS_TEXT`); WhatsApp template
bodies are listed in [notifications.md](notifications.md) and need re-approval.

## Provider dashboard (`/dashboard`)

Translated (`dashboard.*`, en/hi/te). Greeting by local time + organisation + date; `Invite parent` (cases whose child
has no parent account → the case's parent-code panel, `#parent-code`), `Import children`, `New case`; then:

- **Stat cards**: active children (a session in the last or next 30 days), sessions this week (Monday start),
  attendance over 30 days (present / present + absent + late family cancellation), home-practice logs this week.
- **Today** (`components/dashboard/TodayPanel.tsx`): today's sessions with one-tap `Present` / `Absent` (044's
  `POST /api/appointments/:id/attendance`, which re-checks the actor; corrections stay on the register) and
  `Write note` (038) once present; **To do** counts with links; 044's `Needs attention` list below.
- **Cases**: filter chips All / Needs review (intake done, in assessment) / Booked / Referred and a search (child or
  parent alias), plain GET.

`lib/dashboard/today.ts` `loadDashboardToday(userId, { timeZone })` scope = 044's register: owner/admin see the whole
organisation, members the sessions of their own provider profile; case-based counts use `accessible_cases`.

| To do | Counted | Link |
|-------|---------|------|
| Notes to write | present in-clinic sessions of the last 14 days with a case and no recording / session note | the scribe form for the newest one |
| Attendance not marked | 044 `listNeedsAttention` (over 24 h) | `#needs-attention` |
| ISAA items to confirm | `facts.status = 'suggested'` in accessible cases | the first session's review |
| Intake briefs to review | `pre_session_brief` / `generic_intake_brief` reports still draft | the case's Brief tab |
| Unread messages | 027 thread unread counts | `/dashboard/messages` |
| Series conflicts | 043 `listManageableConflicts` | `/dashboard/schedule` |
| Balances due (owner/admin) | 045 `listBalancesDue` with a positive balance | `/dashboard/fees` |

## Case default tab (FR-5)

`lib/cases/default-tab.ts`: a case is past the assessment when it was referred, has a final assessment report, an
active (or completed) plan, or an active/paused weekly series. Then the dashboard opens it on **Sessions**
(`/cases/<id>/sessions`: goal progress from 025, then the sessions and notes); otherwise on the Overview. ISAA review
stays inside each ISAA session, one tab away.
