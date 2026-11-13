# Check-in recommendations, milestones and free options (ticket 048)

The public check-in (`/screen`) is for children **up to 8 years**. This page lists the content that a clinician
must review before the pilot (048 NFR-2) and how to keep it up to date. Everything here is a **draft pending
clinical review**: a human task, not done by the build.

## 1. Age bands

| Band (stored value) | Shown as | What happens |
|---|---|---|
| `under-18m` | Under 18 months | No questions, no session. Milestone guidance (section 3) and "talk to your paediatrician", with `/find` links for paediatricians and developmental paediatricians. |
| `18-30m` | 18-30 months | ISAA-derived 18-35 month items, or M-CHAT-R/F when `MCHAT_LICENSED=true` (section 5). |
| `31-71m` | 2½-5 years | ISAA-derived items (unchanged). |
| `6-8y` | 6-8 years | ISAA-derived items (unchanged). |
| `9y+` | 9 years or older | No questions, no session: "This check-in is for children up to 8. Please talk to your child's doctor or a child psychologist." plus `/find`. |

Old check-ins keep their 033 band (`18-36m`, `3-5y`, `6-9y`, `10y+`); they still resume, finish, save and show on the
child page. New sessions only accept the three middle bands (`POST /api/screen/sessions` answers 400 otherwise).

Before the questions (voice or tap) the parent can tick **What worries you most?** (any, or none): speech and talking,
playing and getting along with others, movement/balance/hand use, senses (noise, touch, food), behaviour and
meltdowns, learning and school (not offered for 18-30 months). Stored as codes in `screen_sessions.concerns`; nothing
identifying.

## 2. Who can help first (`lib/screen/recommend.ts`) - for clinical review

| Worry | Provider types (in order) |
|---|---|
| Speech and talking | Speech-language pathologist |
| Movement, balance, hand use | Occupational therapist, physiotherapist (physio for movement only) |
| Senses (noise, touch, food) | Occupational therapist |
| Playing and getting along with others | Developmental paediatrician, child psychologist - put **first** (an evaluation first) |
| Behaviour and meltdowns | Child psychologist, ABA therapist |
| Learning and school, 6-8 years | Special educator, child psychologist |
| Learning, under 6 | Developmental paediatrician, special educator |
| "Closer look" result (any band except "no strong signs") | Developmental paediatrician in **second** place, child psychologist added |
| No worry and no signs | Paediatrician, developmental paediatrician |

Rules: worries in the order of the table (playing/social moves to the front), duplicates removed, at most 4 types. The
first card explains why in one sentence (`screen.recommend.reasons.*`, en/hi/te). Example (acceptance check E-1):
speech + closer look gives speech-language pathologist, developmental paediatrician, child psychologist.

Below the cards, **Book a visit near you** shows up to 3 verified providers (FR-10) from
`GET /api/screen/sessions/:id/providers?lat&lng` (default central Hyderabad, 25 km): the nearest of each recommended
type first, then filled in the same order, displayed by type then distance, each with its next 2 free times. A time
links to `/book/<profileId>?service=<id>&start=<ISO>`, which opens the booking flow with that slot selected. Never
shown after a red flag (409).

## 3. Milestones under 18 months (`lib/screen/milestones.ts`) - for clinical review

Most babies: smile back at you (by about 2 months); babble and make sounds back (6); turn when you call their name
(9); point at things or wave bye-bye (12-15); say a few words like "mama" or "dada" (15). Plus: "If your baby stops
doing something they could do before, see a doctor soon." Text in `screen.under18m.*` (en/hi/te).

## 4. Free government options (`lib/screen/free-services.ts`)

Shown on every non-urgent result: **District Early Intervention Centre (DEIC)** at the district hospital (RBSK), free
for children up to 6, and **NIEPID, Secunderabad** (Manovikas Nagar, Bowenpally, Secunderabad 500009, +91 40 2775 1741,
toll-free 1800 572 6422, checked on niepid.nic.in on 2026-11-13), with "check timings before you go".

To update: check the official source, edit the entry and set `FREE_SERVICES_LAST_CHECKED` (the page shows "Details
last checked on ..."). Open question (rd.md): per-district DEIC details (Hyderabad, Rangareddy, Medchal); until then
the DEIC card says to ask at the district hospital reception.

## 5. M-CHAT-R/F (`MCHAT_LICENSED`, default `false`)

`MCHAT_RF` is in the 024 registry (`schemas/mchat-rf.json`, `clinical_instruments`, new column `licence_ref`) with the
published scoring: one point per item answered with its risk answer ("yes" for items 2, 5 and 12, "no" for the
others); 0-2 low, 3-7 moderate (offer the Follow-Up), 8-20 high (refer straight away). The Follow-Up is an optional
second step for moderate results only: each item that scored gets pass/fail (`POST /api/screen/sessions/:id/follow-up`);
2 or more fails = positive, 0-1 = negative. Mapped to the check-in result bands: low / Follow-Up negative ->
"no strong signs", moderate -> "worth discussing", high / Follow-Up positive -> "see a professional soon".

**The licence for commercial digital use is unverified, so the item and Follow-Up wording are placeholders.** To turn it
on (human task):

1. Get written permission from the authors (mchatscreen.com) for use in DoctorNearMe.
2. Replace the placeholder `text_en` of the 20 items and the 20 Follow-Up items in `schemas/mchat-rf.json` with the
   licensed wording, set `status` and `licence` (`status: "licensed"`, `reference`), and add a migration that updates
   the `MCHAT_RF` row (`definition`, `licence_ref`). `tests/clinical-contracts.test.ts` checks the row mirrors the file.
3. Use only official Hindi/Telugu translations (out of scope here: the questions stay English).
4. Set `MCHAT_LICENSED=true`. Check-ins already started keep their instrument (`screen_sessions.instrument`).

## Review checklist (clinician)

- [ ] Section 2 mapping and the reason sentences (`screen.recommend.reasons.*`, `screen.recommend.roles.*`)
- [ ] Section 3 milestones and ages
- [ ] Section 4 contact details (and the DEIC wording)
- [ ] M-CHAT-R/F licence (section 5)
