# 056: Pilot readiness (free first pilot)

**Status:** done (product owner, 2026-11-20: "make the product ready for our first pilot customer for free")
**Mode:** solo
**Runs:** waits for 055

## Summary

055 makes the pilot free. This ticket removes the remaining blockers for a first real centre, with payments and
licences deferred to the end:

- families can sign in without SMS (phone codes need DLT in India);
- the deployment can't silently go live on demo settings;
- a new centre knows what to do in its first week;
- there is one runbook for the pilot.

## Functional requirements

- **FR-1** - Phone sign-in follows Supabase. `isPhoneAuthEnabled()` (`lib/family/auth-settings.ts`) reads the public
  `/auth/v1/settings` (`external.phone`), like the Google check; `DEMO_MODE` keeps the synthetic numbers.
  - When it is off, `/family/login` shows Google only, with "Phone sign-in is not available yet…".
  - If no method works at all, the login shows "Sign-in is not available right now. Please ask your centre…".
  - Family settings hide "Add phone"; an already linked phone can still be removed.
- **FR-2** - Pilot go/no-go on `/admin/ops` (platform admins). `pilotReadiness()` (`lib/readiness/pilot.ts`) checks
  configuration only and never shows a secret's value. The verdict is **Blocked** while any blocker fails, otherwise
  **Ready**.
  - **Blockers:**
    - demo mode off and demo listings hidden;
    - an https app URL and `CRON_SECRET`;
    - email on a verified sender;
    - a reviewed privacy notice and a grievance officer;
    - a family sign-in method;
    - the intake call (ElevenLabs) and AI notes (Gemini);
    - Razorpay keys if payments are on.
  - **Warnings:** WhatsApp, phone sign-in (DLT), Telugu on the voice agents, Turnstile, synthetic seeding, and
    dedicated secrets.
  - **Deferred** (never block): payments off and M-CHAT-R/F off.
- **FR-3** - "Set up your centre" on `/dashboard`, for organisation members. There are six steps, each done when the
  data exists (`lib/dashboard/setup.ts`, scoped like the dashboard: the user's active organisations and
  `accessible_cases`):
  1. invite the team (`/dashboard/team`);
  2. add children (`/dashboard/import`);
  3. connect a family (clinic code);
  4. a weekly timetable (the case's `TimetableCard`);
  5. a first session note;
  6. a published home program.

  The card hides itself when all steps are done. It is translated into en/hi/te.
- **FR-4** - `docs/pilot-runbook.md` covers:
  - the free-pilot settings and the deployment checklist (matching FR-2);
  - centre and family onboarding and a dry run;
  - running the pilot (daily and weekly checks, PMF signals);
  - what is deferred and how to turn it on.

  `.env.example` points to it; `docs/guardian-auth.md` documents FR-1.

## Out of scope (deferred)

- Payments, platform fee and payouts (055 keeps them off).
- The M-CHAT-R/F licence and DLT registration.
- Native-speaker review of Hindi and Telugu.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | A `PHONE_OTP_ENABLED` flag? | No: read Supabase's own settings | One source of truth; the phone form appears by itself once the SMS provider is set up |
| D-2 | Block the pilot on warnings? | No | WhatsApp, DLT, Telugu voice and Turnstile improve the pilot but are not needed for a first free centre |
| D-3 | Manual ticks on the checklist? | No, data-driven | Can't drift from reality; disappears when the centre is running |
