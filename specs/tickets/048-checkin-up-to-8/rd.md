# 048: Parent check-in for children up to 8 (age-aware questions, concern-based advice, free options)

**Status:** ready (approved 2026-11-13: "fix the user journey so that I get a rating of at least 9")
**Mode:** solo
**Runs:** waits for 051: same screen components (voice needs sign-in)

## Summary

The product owner decided on 2026-11-13 that the target age is **up to 8 years**. Today `/screen` offers
the bands `18-36m`, `3-5y`, `6-9y` and `10y+`, all with ISAA-derived questions. It always suggests the
same four provider types. ISAA is a disability-certification tool that performs poorly under age 5,
which is the core early intervention group.

This ticket:
1. limits the check-in to 8 years;
2. lets the instrument registry use a toddler-specific instrument (M-CHAT-R/F) once licensed;
3. adds a "what worries you most?" step, so the result recommends the **right kind of professional**;
4. shows free government options.

The voice/tap choice already exists (033) and stays.

## Functional requirements

- **FR-1** – Age bands become `under-18m`, `18-30m`, `31-71m` (2½–5 years) and `6-8y`. `9y+` shows a
  short page: "This check-in is for children up to 8. Please talk to your child's doctor or a child
  psychologist." It also links to `/find`. Existing stored sessions keep their old band values (no
  migration of answers).
- **FR-2** – `under-18m`: no questions. Show plain milestone guidance (a static, reviewed list: smiles,
  babbles, responds to name, points or waves by 12–15 months). Then advise "talk to your
  paediatrician", with a `/find` filter for paediatricians and developmental paediatricians.
- **FR-3** – `18-30m` uses the instrument key `MCHAT_RF` behind the feature flag `MCHAT_LICENSED`
  (default **false**). When it is false, it falls back to the ISAA-derived 18–35-month items (today's
  behaviour).
  - Add M-CHAT-R/F to the 024 `clinical_instruments` registry: 20 items, the published scoring, and the
    Follow-Up interview as an optional second step.
  - Store the licence reference in the registry row. The scoring follows the official algorithm,
    including the "moderate risk → follow-up" rule.
- **FR-4** – `31-71m` and `6-8y` keep the ISAA-derived items. The result copy says "developmental
  check-in, not a diagnosis" (unchanged).
- **FR-5** – Concern step (before the questions, voice or tap): "What worries you most?" with
  multi-select options: Speech and talking · Playing and getting along with others · Movement,
  balance, hand use · Senses (noise, touch, food) · Behaviour and meltdowns · Learning and school. The
  answers are stored with the session (no identifiers).
- **FR-6** – The result recommends provider types from the concerns and the result level, using a
  reviewed mapping in `lib/screen/recommend.ts`:
  - speech → speech-language pathologist;
  - movement or senses → occupational therapist (physiotherapist for movement only);
  - playing/social or a "closer look" result → developmental paediatrician or child psychologist first,
    for an evaluation;
  - behaviour → child psychologist / ABA;
  - learning, age 6–8 → special educator and child psychologist.
  
  The first card explains *why* in one sentence ("Because you mentioned speech, a speech therapist is a
  good first step"). The `/find` search is prefiltered in that order.
- **FR-7** – Free options card on every non-urgent result. It lists "District Early Intervention Centre
  (DEIC) at your district hospital, free for children up to 6" and "NIEPID, Secunderabad", with address,
  phone and "check timings before you go". The content is static in `lib/screen/free-services.ts`, with a
  `last_checked` date that the admin updates.
- **FR-8** – Red-flag handling stays unchanged and comes first (033 FR-7).
- **FR-10** – Fewer steps to a visit: below the recommendation, show up to **3 matching providers**. Order them
  by recommended type, then distance from the location the parent gives (or Hyderabad centre). Each shows
  the next 2 free slots as chips (029/030 APIs). A chip goes straight to `/book/[profileId]?start=...` with
  the slot pre-selected, so check-in → booking is one tap. `See more` opens `/find` with the filters set.
- **FR-9** – en/hi/te strings for all new copy. The voice agent's `{{age_band}}` and question list follow
  the new bands (update `docs/elevenlabs-screen-agent.md`).

## Non-functional requirements

- **NFR-1** – No child name, DOB or contact details are collected before consent (rule 6). Age is a band
  only.
- **NFR-2** – The mapping and the milestone text are marked for clinical review in `docs/` (human task).

## Affected areas

- `lib/screen/**`, `components/screen/**`, `app/screen/**`, the 024 instrument registry seed
- `docs/elevenlabs-screen-agent.md`, `messages/{en,hi,te}.json`, `tests/screen-*.test.ts`

## Out of scope

- INDT-ASD for clinicians (needs permission from INCLEN; separate ticket).
- Validated Telugu/Hindi translations of M-CHAT-R/F (use official translations only, when licensed).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Upper age | 8 years | Product owner 2026-11-13 |
| D-2 | Toddler instrument | M-CHAT-R/F behind a licence flag; ISAA-derived fallback | ISAA is weak under 5; licence unverified |
| D-3 | Recommendation | Concern-based mapping, reviewed by a clinician | Parents don't know OT vs speech vs dev-ped |

## Open questions

- M-CHAT-R/F licence for commercial digital use (contact the authors / mchatscreen.com). Human task.
- Should DEIC details be per district (Hyderabad, Rangareddy, Medchal) at launch?
