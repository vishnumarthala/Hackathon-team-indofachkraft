# 012: Referral packet, specialist page and email

**Status:** draft
**Mode:** solo
**Runs:** waits for 002, 003, 004: needs `seed:demo -- --confirmed`, lib/scoring.ts and the Referral tab placeholder

## Summary

Phase 3: when the therapist decides to refer (and the parent consented), CareThread builds a referral
packet from confirmed facts - scores, red flags, the strongest evidence with timestamps, intake
highlights - plus a short Gemini summary, and emails the specialist a private link. The specialist page
shows the packet and lets them play the exact audio moment behind each piece of evidence, so the parent
never has to repeat the story.

## Functional requirements

- **FR-1** - Referral tab `/cases/<id>/referral` replaces the placeholder. A recommendation box for the
  latest `extracted` session: `Referral recommended` with each reason as a list item, or
  `No referral rule triggered`, plus the label `Suggested by CareThread - the therapist decides`
  (from `recommend()` with `scoreIsaa`, `collectRedFlags` incl. intake case-sheet booleans, FACP).
  With no extracted session: `Process and confirm a session before referring.`
- **FR-2** - A form: `Specialist name`, `Specialist email`, `Reason for referral` (textarea prefilled with
  the reasons joined by `; `, or empty), a checkbox labelled
  `The parent consented to share this case with the specialist`, and a button `Send referral` disabled
  until the box is ticked. On success it shows `Referral sent`, the link, a link `Open specialist view`
  and one of `Email sent to <email>`, `Email not sent (demo mode)`, `Email could not be sent`. Below,
  a list of earlier referrals: specialist name, date, status (`Sent`, `Viewed`), link.
- **FR-3** - `POST /api/cases/:id/refer` body `{ specialist_name (1-100), specialist_email (email),
  reason (3-1000), parent_consent }`: 400 with field messages (`parent_consent` must be `true`:
  `Parent consent is required`); 404 `{ error: "Case not found" }`; 422
  `{ error: "Confirm at least one ISAA item before referring" }` when the latest extracted session has
  no confirmed/edited ISAA fact with a value. Uses the latest extracted session; if it has no confirmed/edited values,
  return 422 instead of silently choosing a different session from the one shown in FR-1.
  Generates the summary first, builds the packet (FR-4), inserts the referral
  (`share_token` = `newToken()`, `status` `sent`), emails the specialist (subject
  `Referral: <child_alias> (CareThread)`, text with the reason and `<NEXT_PUBLIC_APP_URL>/specialist/<token>`),
  stores `emailed`, sets `cases.status` `referred`, audits `referral.created`. Returns 201
  `{ referral_id, url, emailed }`. Gemini failure -> 502 `{ error: "Referral could not be prepared" }`
  and nothing is stored. Email failure -> still 201 with `emailed: false`.
- **FR-4** - `lib/referral/packet.ts` `buildPacket(...)` (pure) returns `ReferralPacket`
  (`docs/system-design.md` section 6): `isaa` from `scoreIsaa`; `facp` score + band; `red_flags` from
  `collectRedFlags`; `recommendation` from `recommend`; `key_evidence` = confirmed/edited ISAA facts with
  `evidence.verified` true, sorted by value desc then item id, max 8; `intake_highlights` = first 5
  brief `parent_reported` entries as `<label>: <value>` (empty without a brief); `decisions` = every
  confirmed/edited ISAA fact `{ item_id, rating, status, confirmed_at }`; `summary` is a validated
  input generated before calling the pure function by Gemini
  `generateJson({ task: "referral", system: prompts/referral.md, schema: ReferralSummarySchema })` from
  confirmed facts + intake highlights; `therapist` = case therapist name. Call `scoreIsaa` with only
  confirmed/edited facts; provisional total uses `minimum_total`, and domain values are labelled
  confirmed sums. Never expose `suggested_total` or suggested ratings in the stored packet or page.
- **FR-5** - Public page `/specialist/<token>`: unknown or `revoked` token -> 404 with
  `This referral link is no longer valid.` First view sets `status` `viewed` and `viewed_at`. Shows:
  `<h1>Referral: <child_alias></h1>`, `From <therapist> · <YYYY-MM-DD>`, `Reason`, the summary,
  `Questions for the specialist`, an ISAA panel (`formatIsaaScore`, domain table), FACP (if set),
  red flags, the recommendation with `Suggested by CareThread - the therapist decides`, `Key evidence`
  (`<item_id>. <item text> - <rating label>`, the quote, and a button `Session <n> · <mm:ss>` that plays
  the session audio from that second, or plain text `Session <n> · <mm:ss>` when the session has no
  audio), `Parent-reported at intake` (highlights) and the footer
  `Prepared with CareThread. AI documents, the clinician decides. This is not a diagnosis by AI.`
- **FR-6** - `components/referral/EvidencePlayer.tsx` exports a client `EvidencePlayerProvider` (one
  hidden `<audio>`; signed URLs per recording id passed in as props, valid 1 hour) and a hook
  `useEvidencePlayer()` with `play(recordingId, startSec)`. Ticket 013 reuses it for citations.
- **FR-7** - `tests/packet.test.ts` covers `buildPacket` (key evidence order and limit, only verified,
  decisions list, intake highlights limit, provisional score).

## Non-functional requirements

- **NFR-1** - The specialist page never shows `suggested` (unconfirmed) AI ratings.
- **NFR-2** - The packet is only reachable through `/specialist/<share_token>`; there is no listing of
  referrals or packets without a token.

## Affected areas

- `app/cases/[id]/referral/page.tsx` (changed: placeholder -> referral UI)
- `components/referral/ReferralForm.tsx`, `components/referral/EvidencePlayer.tsx`,
  `components/referral/PacketView.tsx` (new)
- `app/api/cases/[id]/refer/route.ts`, `app/specialist/[token]/page.tsx`,
  `app/specialist/[token]/not-found.tsx` (new)
- `lib/referral/packet.ts`, `lib/queries/referrals.ts`, `prompts/referral.md` (new)
- `tests/packet.test.ts` (new)

## Don't touch

- `lib/scoring.ts`, `lib/types.ts`, `lib/email.ts`, other case tabs, `supabase/migrations/**`, `package.json`

## Out of scope

- "Ask the case" chat (013), revoking links in the UI, specialist accounts, PDF export.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Referral with provisional score | Allowed if >= 1 item confirmed; packet shows `at least` wording | demo flow; clinician decides when to refer |
| D-2 | Facts in the packet | Only confirmed/edited | AI documents, the clinician decides |
| D-3 | Consent | Required checkbox; stored as `parent_consent = true` | team plan: parent consents to share |
| D-4 | Fee per referral | Never mentioned anywhere | illegal kickback (team plan section 8) |
| D-5 | Email recipient in demo | `DEMO_EMAIL_TO` redirect from `lib/email.ts` | grill D-5 |

## Open questions

None.
