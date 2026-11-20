# First pilot runbook (free pilot)

How to run DoctorNearMe with the first real pilot centre in Hyderabad, **free of charge** for the centre and its
families. Payments, the platform fee and licences are deferred to the end ([deferred](#7-deferred-to-after-the-first-pilot)).

Related: [PMF check](../specs/grill/doctornearme-pmf-check.md) · [system design](system-design.md) ·
[privacy processors](privacy/processors.md) · [incident response](privacy/incident-response.md) ·
[guardian sign-in](guardian-auth.md) · [import children](import-children.md) · [referral kit](referrals.md)

## 1. What "free pilot" means

| Area | Pilot setting | Effect |
|---|---|---|
| Payments (055) | `PAYMENTS_ENABLED` unset (or anything but `true`) | Bookings confirm without payment; attendance creates no charges; fee, package and payout pages, APIs, jobs and payment notifications are off; `/for-centres` says "Free for pilot centres" |
| Check-in tool (048) | `MCHAT_LICENSED` unset | Parents under 2½ get the ISAA-derived questions; M-CHAT-R/F waits for its licence |
| Phone sign-in | No SMS provider in Supabase (DLT pending) | Families sign in with Google; the phone form is hidden automatically and appears once Supabase reports phone sign-in (056) |
| Directory | `SHOW_SYNTHETIC_LISTINGS=false` | Only real, verified providers are listed; never seed synthetic profiles in the pilot database |

## 2. Deployment checklist

Set these in the pilot deployment (Vercel project settings, never in git). The **Pilot readiness** card on
`/admin/ops` checks them and shows **Ready** or **Blocked**; do not invite families until it says Ready.

**Blockers (the card turns red without them):**

- `DEMO_MODE` unset or `false`.
- `SHOW_SYNTHETIC_LISTINGS=false`, and `ALLOW_SYNTHETIC_SEED` unset.
- `NEXT_PUBLIC_APP_URL=https://…` (the real domain), and the Supabase URL and keys of the **pilot** project.
- `CRON_SECRET` (Vercel cron sends it; without it the outbox, reminders and retention jobs never run).
- `RESEND_API_KEY` and an `EMAIL_FROM` on a verified domain (Resend's onboarding sender only reaches the account
  owner).
- `PRIVACY_NOTICE_REVIEWED=true`, only after the legal review of `/privacy`, and `GRIEVANCE_OFFICER_EMAIL`.
- Family sign-in: the Google provider switched on in Supabase Auth (or an SMS provider).
- `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_WEBHOOK_SECRET` (intake call) and `GEMINI_API_KEY`
  (session notes, extraction).

**Recommended (warnings):** `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`; `ELEVENLABS_*_LANGUAGES=en,hi,te`
once the Hindi and Telugu presets exist ([voice languages](voice-languages.md)); `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY`; dedicated `INTAKE_LINK_SECRET`, `CONSENT_IP_SALT` and `TOKEN_ENCRYPTION_KEY`.

**Database:** apply every migration to the pilot project with `npm run db:push`, then run `npm run verify`
locally against a migrated database. Locally, check that `DATABASE_URL` really points at **this** project's
Supabase (`project_id = "carethread"`): other local Supabase projects can hold the default port 54322, and tests
against the wrong database fail with "missing column" errors.

## 3. Onboard the pilot centre

1. The owner creates their account and practice at `/join` (or an admin seeds the profile at `/admin/providers`
   and sends a claim link). Verification at `/admin/verifications` is only needed to be **listed** in the
   directory; the workspace works before that.
2. The owner opens `/dashboard`. The **Set up your centre** card walks through the first week, and each step ticks
   itself when the data exists:
   1. Invite the team (`/dashboard/team`).
   2. Add the children: CSV import from Excel or Google Sheets (`/dashboard/import`).
   3. Connect a family: create the clinic code on the case and share it on WhatsApp (valid 72 hours, single use).
   4. Set a weekly timetable on the case (repeat sessions, then mark attendance in `/dashboard/register`).
   5. Write the first session note (record or upload a session, confirm the AI draft).
   6. Publish a home program so the family can practise between sessions.
3. Optional: the waiting-room QR poster (`/dashboard/profile/poster`) once the profile is verified and listed.

## 4. Families (journey #1)

The centre shares the clinic code → the parent opens `/family/login`, signs in with Google → enters the code at
`/family/children/claim` → gives permissions (or the centre records paper consent at the desk) → the intake call
link → the family app: visits, timetable, plan, home activities, messages. The parents' home page (`/`) links
"Already with a centre? Enter your clinic code" above the fold.

## 5. Dry run before the first real family

With a **synthetic** child in the pilot centre, one person plays the parent on a phone:

1. Import a one-row CSV, create the clinic code, share it to your own WhatsApp.
2. Sign in with Google on the phone, claim the child, grant permissions; then withdraw one permission and check
   that the related feature stops.
3. Do the intake call in Telugu or Hindi (if enabled) and check the brief on the case.
4. Create a weekly series, mark one session attended, record a short session, confirm the note, publish a goal and
   a home activity; log practice from the phone; check the Next step card on `/family`.
5. Book a video and an in-clinic visit from `/find`: both confirm without any payment step.
6. Request a data export and a deletion for the synthetic child at `/family/children/[id]/privacy`; follow them in
   `/admin/privacy/requests`.
7. `/admin/ops`: the outbox has no failed deliveries and the readiness card says Ready. Delete the synthetic child.

## 6. Running the pilot

- **Daily:** `/admin/ops` (outbox failures, voice minutes, readiness), `/admin/notifications` for dead deliveries.
- **Weekly:** the PMF signals from the [PMF check §6](../specs/grill/doctornearme-pmf-check.md): active therapists,
  accepted AI notes, families who claimed and consented, weekly home-practice logs, documentation time saved
  (ask), and check-ins started from posters (`/dashboard/profile/poster`).
- **Incidents and privacy requests:** [incident response](privacy/incident-response.md); grievance mails go to
  `GRIEVANCE_OFFICER_EMAIL`; requests are handled in `/admin/privacy/requests` (30 days).

## 7. Deferred to after the first pilot

| Item | What turns it on |
|---|---|
| Payments, packages, payouts, platform fee | CA sign-off on the fee rate and GST, Razorpay merchant agreement and live keys, Route linked accounts per centre ([payouts](payouts.md)); then `PAYMENTS_ENABLED=true` |
| Phone sign-in | DLT-registered SMS sender and template, SMS provider in Supabase Auth; the login shows the phone form by itself |
| M-CHAT-R/F for toddlers | Commercial digital-use licence; real item text in `schemas/mchat-rf.json`; then `MCHAT_LICENSED=true` |
| Native-speaker review of Hindi and Telugu | Reviewers approve rows in `messages/REVIEW.md` (do this before inviting families who read hi/te) |
