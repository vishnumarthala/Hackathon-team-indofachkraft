# Grill: DoctorNearMe MVP (autism and early intervention)

**Status:** confirmed
**Started:** 2026-11-12
**Rounds:** 7 (all answered by the product owner) + one independent plan review

Inputs: the CareThread MVP in this repo, `doctornearme_mvp_product_architecture_plan.md` (general
telemedicine "near me" plan) and `DRnME-NextJS-Complete-Migration-Guide.md` (old DRnME feature inventory).
The product owner chose to lean toward autism and early intervention. Tickets 016-042 build against this
record; where a ticket's Decisions table disagrees, the ticket wins for that ticket.


## 1. Problem & positioning
CareThread today = B2B clinician tool for autism assessment (parent voice intake → session transcription →
ISAA extraction → report → referral). Roles: `admin | therapist`. No patients, geo, booking, video.

**DoctorNearMe** = **therapist/centre SaaS first** (CareThread engine, extended with old DRnME care features),
plus a **public "near me" directory + one-off booking** as the acquisition channel. Differentiator in the pitch:
**voice-first AI** (screen, book, intake, scribe, follow-up). Launch city: **Hyderabad**. Real pilot (not demo-only).

Sources merged: current repo, `doctornearme_mvp_product_architecture_plan.md`, `DRnME-NextJS-Complete-Migration-Guide.md`.

## 2. Decisions (from grilling)
| Area | Decision |
|---|---|
| CareThread workflow | Kept as module "Child Development (powered by CareThread engine)" |
| Positioning | Therapist/centre SaaS + directory/booking as acquisition |
| Tenancy | Organisation = tenant; centre admin invites providers; solo practitioner = 1-person org |
| Provider types | Dev-ped, child psychiatrist, child psychologist, speech, OT, ABA, special educator, physio, GP/peds; centres as listing type |
| E-Rx | Only prescribers (dev-ped, child psychiatrist, GP/peds). Others: notes + AI reports |
| Booking | One-off only (no recurring series/packages). Video + in-clinic. Razorpay **test mode** |
| Old DRnME features kept | Guardian + multi-child, care team, IEP/SMART goals + progress, home program, assessment portal, messaging, document vault, health profile, ratings |
| Old DRnME dropped | Community/volunteers/jobs, medical tests/labs, EHR/pharmacy, analytics dashboards, 102-table schema, 7 roles, React→Next migration mechanics |
| Availability / onboarding | Simple version from DoctorNearMe plan (weekly rules + date overrides; self-register + admin seeding + claim link) |
| Voice agents | Parent screen (landing), voice booking (web widget), pre-consult intake, AI scribe, in-app follow-up agent ("ask about my child's plan/prescription") |
| Voice languages | New agents English only; existing Child-Dev intake agent stays en/hi/te |
| UI language | en / hi / te (i18n) |
| Screening instrument | ISAA-derived parent questions (clearly "not a diagnosis") |
| Safety | Red-flag detection → stop, advise 108/112, no booking |
| AI on real data | Allowed with explicit per-feature DPDP consent + disclosure of ElevenLabs/Google processing outside India |
| Child consent | Verifiable guardian consent per child; consent log; no tracking/ads on child pages |
| AI scribe → Rx | AI drafts; prescriber must review/edit/sign before PDF |
| Verification | Manual admin check of NMC/State council/RCI/ASLP credentials |
| Auth | Guardians: Google Sign-In + phone OTP; providers: email/Google |
| Video | Google Meet via provider's free @gmail OAuth first; patient joins signed-in & is admitted from lobby; built-in WebRTC later |
| Scribe capture | Only in-clinic recording (and future in-app room) — NOT Meet calls |
| Notifications | Meta WhatsApp Cloud API + Resend email (.ics) + in-app |
| Geo | Supabase PostGIS + Google Maps/Places |
| Rebrand depth | All user-facing text/metadata/emails/agent prompts/docs; internal identifiers may stay |
| Team | Built by AI agents using existing ticket workflow (`specs/tickets/NNN-*`, BOARD.md) |
| Milestone order | M1 SaaS depth → M2 directory/booking/voice → M3 video/scribe/Rx/follow-up |

## 3. Flagged risks / tensions (accepted, tracked)
1. **ISAA as parent self-screen** is not a validated parent-report instrument → wording "developmental check-in, not a diagnosis"; route all positives to a professional.
2. **English-only new voice agents** in Hyderabad (Telugu/Hindi parents) while UI is trilingual — easy to add languages later via ElevenLabs agent config.
3. **Scribe vs Meet**: scribe unavailable for video consults until built-in room exists.
4. **Google OAuth verification** (calendar.events sensitive scope) takes weeks; until verified: ≤100 test users, 7-day token expiry → start submission immediately.
5. **Meta WhatsApp** business verification + template approval; **SMS OTP needs DLT** registration in India → human lead-time tasks.
6. **Cross-border processing** (ElevenLabs, Gemini, Supabase region) → consent copy + privacy policy; consider Supabase Mumbai region for the pilot project.
7. **RLS**: current tables have RLS enabled but no policies and app uses service role; multi-tenant + guardians demands real org-scoped policies or strict server-side scoping.
8. Next.js 16.4 has breaking changes — agents must read `node_modules/next/dist/docs/` before coding (AGENTS.md).

## 4. Architecture — reuse map
- **Keep as-is**: Supabase/Next stack, `lib/gemini.ts`, `lib/elevenlabs/*`, audit log, Resend email, ticket workflow, Vitest.
- **Generalize**: `cases` → belongs to `organization` + `child`; `recordings`/session pipeline → AI scribe for any provider type; `facts` instruments registry (ISAA first); `reports` kinds + `session_note`, `rx_draft`; `lib/ask` → guardian follow-up agent; intake token flow → triggered by booking.
- **New**: orgs/memberships, guardians/children/consents, care team, health profile, documents, assessments/templates, IEP plans/goals/progress, home program, messaging (Supabase Realtime), provider public profiles + verification, PostGIS directory, availability + appointments (atomic via `EXCLUDE USING gist` on provider + tstzrange), Razorpay test, notifications outbox + cron reminders, Google Meet integration, E-Rx PDF, ratings, i18n.

### Roles
`user_profiles.role`: `platform_admin | provider | guardian` (migrate `admin→platform_admin`, `therapist→provider`)
`org_members.org_role`: `owner | admin | member`; `provider_profiles.provider_type` + `can_prescribe`.
`proxy.ts` gains role-aware routing: `/app/**` provider, `/family/**` guardian, `/admin/**` platform admin; public `/`, `/find`, `/p/[slug]`, `/screen`.

### Voice agents (ElevenLabs)
| Agent | Surface | Tools/flow | Lang |
|---|---|---|---|
| Parent screen | `/screen` + landing | ISAA-derived Qs → result + red flags → nearby providers | en |
| Voice booking | widget on `/find` | server tools: `search_providers`, `get_slots`, `hold_slot`; final confirm requires signed-in guardian | en |
| Pre-consult intake | link in booking confirmation | Child-Dev: existing agent (en/hi/te); others: generic intake agent → brief | en (+existing) |
| AI scribe | in-clinic recording | existing Scribe v2 + extraction → session note, goal progress, Rx draft | n/a |
| Follow-up | guardian portal | grounded on finalized plan/report/Rx with citations (reuse `lib/ask`) | en |

## 4b. Design rules adopted from plan review (blocking for real pilot)
1. **Legacy migration (017/020)**: expand → backfill → enforce. Legacy cases go to an explicit bootstrap org; unclaimed child records created; case IDs + dependents preserved; never infer guardian ownership or fabricate consent from contact details.
2. **Child vs clinical access (020/022)**: guardian↔child links; org-specific cases (care episodes); provider assignments; explicit cross-org sharing grants. Org membership never auto-exposes a child across orgs.
3. **Authorisation (017)**: `supabaseAdmin()` bypasses RLS → every existing API/read/write/job/signed URL/token endpoint gets resource-level authz helpers (`requireCaseAccess` etc.). RLS policies added separately for browser/Realtime; membership revocation tests. Routing ≠ authz.
4. **Auth/role migration (017/019)**: update role constraint, auth trigger, helpers, guards, callbacks, redirects together; privileged roles assigned server-side only; safe Google↔phone identity linking; keep or redirect `/dashboard`, `/cases/**`.
5. **Internal provider onboarding in M1 (017)**: org creation, invitations, accept/revoke, solo-org. Public listing/claim/credential verification stays in 028.
6. **Consent gates processing (020)**: versioned per-child, per-feature consent checked before collection AND re-checked when queued work runs (intake, transcription, extraction, TTS, referral, screen). Public agents collect no identifiable child data pre-consent. Intake/referral links: expiring, scoped, revocable; booking intake is appointment-bound.
7. **Lifecycle & audit (041 → M1)**: retention, withdrawal, export/deletion incl. external processors, incident procedure; audit events get authenticated actor, survive case deletion, and security-critical writes fail closed.
8. **Clinical contracts (024)**: shared instrument/report/speaker-role contracts defined in M1 keeping ISAA behaviour; legacy seed updates + regression evals for intake, speaker swap, extraction, scoring, report finalisation, referral, parent voice note.
9. **Published versions (039/040)**: one authoritative signed/published representation (fix `content_md` vs `content` drift); follow-up agent retrieves only guardian-authorised published versions; Rx signing checks verified prescriber server-side and stores signer, timestamp, immutable version.
10. **Atomic booking (030)**: `btree_gist`, half-open `tstzrange`, stable provider identity across orgs, blocking statuses, hold ownership + expiry with transactional cleanup/worker, atomic confirm/cancel/reschedule state machine; concurrency tests.
11. **Appointment → case → intake (030/035)**: service snapshot (duration/mode/location/fee); appointment selects/creates org case; appointment-scoped intake attempts, recordings, briefs; idempotent processing.
12. **Outbox first (032 → M1)**: transactional outbox + scheduler + retries + dedup before booking; payment state separate from appointment state; signed idempotent Razorpay webhooks; late-payment-after-expiry behaviour; retry-safe Meet creation.

## 5. Milestones & tickets (continue numbering in `specs/tickets/`)
**M1 — SaaS core + pilot safety**: 016 rebrand · 017 orgs/roles/authz + internal provider onboarding + legacy migration · 018 i18n foundation · 019 guardian auth & portal shell · 020 children, guardian links & consent gating · 021 health profile · 022 care team & sharing grants · 023 document vault · 024 assessment portal & shared clinical contracts · 025 IEP goals & progress · 026 home program · 027 messaging · 032 notifications outbox/scheduler (email/in-app/WhatsApp adapter) · 041 privacy/audit/ops baseline
**M2 — Directory, booking, voice**: 028 public provider profiles & verification (+admin seeding, claim link) · 029 PostGIS directory + Google Maps · 030 availability & atomic booking · 031 Razorpay test · 033 voice screen · 034 voice booking agent · 035 appointment-scoped pre-consult intake · 036 ratings · 042 Hyderabad seed data
**M3 — Video, scribe, Rx, follow-up**: 037 Google Meet integration · 038 AI scribe generalization · 039 E-Rx for prescribers · 040 follow-up agent

### Dependencies
016,017,018: none · 019←017,018 · 020←019 · 021←020 · 022←020 · 023←022 · 024←022 · 025←022,024 · 026←023,025 · 027←022,023,032 · 028←017,018 · 029←028 · 030←028,032,041 · 031←030 · 032←020 · 033←020,024,029,041 · 034←030,033 · 035←021,024,030,041 · 036←030 · 037←030 · 038←024,025,028,041 · 039←021,028,038 · 040←026,033,039 · 041←023,032 · 042←029,030

(Updated after the ticket specs were written: published versions move to 024 because 025/026 publish
plans in M1; M2/M3 tickets that touch real child data wait for the 041 privacy baseline.)

### Product questions resolved on 2026-11-12
| # | Question | Decision | Tickets |
|---|---|---|---|
| 1 | Parents without a smartphone | Paper consent recorded by the centre: printed versioned form, signed scan, provider attestation; counts like digital consent | 020 |
| 2 | "Verified" for OT, physio, ABA, special educators | Council `OTHER`; the platform admin's documented judgement is the verification | 028 |
| 3 | Third-party scripts on child pages | ElevenLabs SDK and Razorpay checkout allowlisted per route; analytics/ads/pixels still banned | 019, 041 |
| 4 | Meet for parents without Google | Google account mandatory for video appointments; parent never added as a calendar guest | 037 |
| 5 | Demo doctors in the pilot | Stay visible with a `Demo profile` badge; demo bookings need an explicit acknowledgement and send nothing outside the app | 028, 029, 042 |
| 6 | Time zone | Viewer's own time zone from the browser (fallback Asia/Kolkata); clinic local time shown when different | 018, 026, 030 |
| 7 | Every-minute scheduler | Vercel Pro cron (already paid) + immediate `after()` drain; Supabase pg_cron as free fallback | 032 |
| - | Care-team discipline before 028 | Free text in M1 | 022 |

## 7. Status of this record

Confirmed by the product owner on 2026-11-12. M1 tickets start with 016 (rebrand) and 017 (orgs, roles, authz).
