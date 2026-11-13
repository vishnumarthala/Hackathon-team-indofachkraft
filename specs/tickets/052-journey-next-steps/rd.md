# 052: Clear next steps – family home, provider "Today", booking "what happens next"

**Status:** ready
**Mode:** solo
**Runs:** waits for 043, 044, 045, 051: the cards read their data (series, attendance, balances, voice quotas)

## Summary

The PMF check scored the journey 5.5/10. One reason is that people don't know what to do next:

- **Family home** (`/family`) is still the 019 stub: two cards, and "Find a specialist" marked "Coming
  soon" although `/find` is live.
- **Provider dashboard** (`/dashboard`) is a bare case list with a hard-coded English heading. There is
  no view of today's sessions, notes to write or reviews waiting.
- **After booking**, families aren't told what comes next (permissions → intake call → visit → home
  program).

This ticket gives each role **one obvious next action**, matching the Figma screens
(`/family — Home` 15:11, `/dashboard — Cases` 18:11).

## Functional requirements

- **FR-1 – Family "Next step" card.** At the top of `/family`, show the single most important action
  for the guardian's children, computed on the server by `lib/family/next-step.ts`, in this priority:
  1. No child linked → `Enter your clinic code` (→ `/family/children/claim`) and `Find a therapist` (→ `/find`).
  2. A permission needed for an upcoming appointment or intake → `Give permission` (→ child privacy page).
  3. An appointment intake call not done → `Start the intake call` (appointment-scoped link, 035).
  4. Balance due or an unpaid package offer (045) → `Pay ₹X` (→ payments).
  5. A visit today or tomorrow → the visit card with time, place or `Join video` (when allowed by 037)
     and `Directions`.
  6. Today's home activities not logged (026) → `Log today's practice`.
  7. Unread messages → `Read message from <therapist>`.
  8. Otherwise → "You're all set", plus the next visit.
- **FR-2 – Family home sections.** Below the Next step card:
  - one card per child (photo initials, age, care team, next visit, home-program streak);
  - "Upcoming visits" (next 3, including series sessions from 043);
  - "From your care team" (latest published plan, note or report);
  - quick links.
  - Remove the "Coming soon" card.
- **FR-3 – Mobile bottom navigation.** On screens < 640 px, the family portal uses a fixed bottom nav with
  5 items: Home, Children, Visits, Messages, Account, with unread badges on Messages. It matches the
  Figma "Bottom nav" component. Assessments and Documents move into the child page and Account; their
  routes stay unchanged. Desktop keeps the top nav.
- **FR-4 – Provider "Today".** `/dashboard` (translated, en/hi/te) shows a **Today** panel above the case
  list:
  - today's sessions for the user (or for the whole org, for owner/admin), with attendance buttons (044)
    and `Write note` (038);
  - **To do** counts with links: notes to write (present sessions without a note), attendance not marked
    (older than 24 h), ISAA items to confirm, intake briefs not yet reviewed, unread messages, series
    conflicts (043), balances due (045, owner/admin only);
  - 4 stat cards as in Figma: active children, sessions this week, attendance rate in the last 30 days,
    and home-program logs this week.
- **FR-5 – Lead with weekly value.** On the case page, the default tab for children past their
  assessment is `Sessions` (notes and goal progress), not ISAA review. ISAA stays one tab away. Cases
  still in assessment open on the current default.
- **FR-6 – "What happens next" after booking.** The confirmation page and `/family/appointments/[id]` show
  a 4-step timeline with live status: Permissions → Intake call (if the service has one) → Visit → Home
  program. Each step has its action button when it's due. The WhatsApp and email confirmation text gets
  the same steps (outbox templates, plain text).
- **FR-7 – Empty states.** Every family and provider list touched here has a helpful empty state with a
  single action (no blank pages).

## Non-functional requirements

- **NFR-1** – `/family` and `/dashboard` render in < 800 ms server time with 50 children (one query per
  card type, no N+1).
- **NFR-2** – Authorisation as before (guardian links, org membership); nothing from other orgs or
  children.
- **NFR-3** – 390 px first; the bottom nav respects safe areas and is keyboard and screen-reader
  accessible.

## Affected areas

- `app/family/(portal)/page.tsx`, `app/family/(portal)/layout.tsx`, `components/family/**`, `lib/family/next-step.ts` (new)
- `app/dashboard/page.tsx`, `components/dashboard/**` (new), the case page default tab
- the booking confirmation page, `app/family/(portal)/appointments/[id]/**`, outbox confirmation templates
- `messages/{en,hi,te}.json`, `tests/next-step-*.test.ts`, `tests/dashboard-today-*.test.ts`

## Out of scope

- Push notifications. Gamification beyond the home-program streak.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | One action or many | One Next step card, then sections | Parents under stress need one clear thing |
| D-2 | Mobile nav | Bottom nav with 5 items | Figma design; thumb reach on Android |
| D-3 | Provider landing | Today first, cases second | Daily work drives retention |
