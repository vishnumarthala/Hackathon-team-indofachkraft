# 013: Ask the case

**Status:** done
**Mode:** solo
**Runs:** waits for 012: adds the chat to 012's specialist page and reuses its EvidencePlayer

## Summary

On the specialist page, the specialist asks plain questions ("When did speech regress?") and gets short
answers that cite the exact fact or transcript moment they come from; clicking a citation plays that
moment. If something is not documented, the answer says so instead of guessing.

## Functional requirements

- **FR-1** - `POST /api/cases/:id/ask` body `{ share_token, question (3-500 chars after trim) }`:
  404 `{ error: "Not found" }` unless `share_token` belongs to a non-revoked referral of that case;
  400 with field messages for a bad question; 429
  `{ error: "Question limit reached for this referral" }` when the referral already has 50 questions.
- **FR-2** - Context sent to Gemini (`generateJson({ task: "ask", system: prompts/ask.md, prompt,
  schema: AskAnswerSchema })`): confirmed/edited ISAA facts as
  `[fact:<uuid>] <item_id>. <item text>: <rating label> - "<quote>" (Session <n> <mm:ss>)`; CASE_SHEET
  facts as `[fact:<uuid>] (parent-reported) <label>: <value>`; the brief summary; transcript segments of
  every session as `[<session_number>:<segment id> | <mm:ss> | <SPEAKER>] text` and of the intake call as
  `[intake:<turn id> | <mm:ss> | <SPEAKER>] text`. Total context is cut to 60,000 characters (intake
  segments are cut first, then the oldest session's segments).
- **FR-3** - Citation check (`lib/ask/citations.ts`, pure): keep a citation only if `kind` `fact` has an
  id in the provided facts or `kind` `segment` has an id in the provided segments; resolve each to
  `{ kind, id, recording_id, session_number | null, start_sec, label }` with `label`
  `Session <n> · <mm:ss>` or `Intake call · <mm:ss>` (facts use their evidence segment; CASE_SHEET facts
  without evidence get label `Intake answers` and `start_sec` 0). Validate against the exact context
  actually sent after truncation, not against the original full case. If `found` is true but no
  citation survives, return `found: false` and the answer `Not documented in this case.` Never treat
  an absent audio file or an expired signed URL as playable.
- **FR-4** - Each answered question is stored in `case_questions` (question, answer, found, resolved
  citations) and audited `case.question_asked` (actor `specialist`). Response 200
  `{ found, answer, citations }`. Gemini failure -> 502 `{ error: "The question could not be answered" }`
  and nothing stored. Enforce the 50-question limit atomically per referral so concurrent requests
  cannot exceed it; release any reservation when generation fails. Route exports `maxDuration = 60`.
- **FR-5** - `prompts/ask.md` follows section 10: answer only from the given facts and segments, max 120
  words, cite ids exactly as given, parent statements are "parent-reported", never diagnose; if not
  documented -> `found: false` and `Not documented in this case.`
- **FR-6** - Specialist page section `<h2>Ask the case</h2>`: earlier questions of this referral (oldest
  first) with answers; a textarea labelled `Your question`; a button `Ask`; three suggestion buttons
  `When did speech regress?`, `Any self-injury?`, `How does he respond to his name?` that fill the
  textarea. Each answer shows citation chips (buttons named by their `label`); clicking a chip calls
  `useEvidencePlayer().play(recording_id, start_sec)` when that recording has audio. Answers with
  `found: false` are shown in grey. While waiting the button shows `Asking…`; errors show the API
  `error` text.
- **FR-7** - `tests/ask.test.ts` covers FR-3 (valid/invalid fact and segment ids, intake labels,
  found-without-citations fallback) and the context cut order in FR-2.

## Non-functional requirements

- **NFR-1** - In DEMO_MODE an answer arrives in < 5 s.
- **NFR-2** - The endpoint never returns facts or segments that were not cited.

## Affected areas

- `app/api/cases/[id]/ask/route.ts` (new)
- `lib/ask/context.ts`, `lib/ask/citations.ts`, `prompts/ask.md` (new)
- `components/referral/AskTheCase.tsx` (new)
- `app/specialist/[token]/page.tsx` (changed: render `AskTheCase` inside the existing `EvidencePlayerProvider`)
- `tests/ask.test.ts` (new)
- An additive migration for atomic question-limit enforcement if needed.

## Don't touch

- `components/referral/EvidencePlayer.tsx`, `lib/referral/packet.ts`, `app/api/cases/[id]/refer/**` (012)
- `lib/types.ts`, `lib/gemini.ts`, existing migrations, `package.json`

## Out of scope

- Streaming answers, follow-up memory between questions, asking from the therapist side.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Retrieval | Whole case in the prompt (cut at 60k chars); no vector DB | one case is small |
| D-2 | Segment id format | `<session_number>:<id>` / `intake:<id>` | ids repeat across recordings (002 D-3) |
| D-3 | Access control | `share_token` in the body must match the case | specialist has no login (grill D-1) |
| D-4 | Abuse limit | 50 questions per referral | protects Gemini credits on a public link |

## Open questions

None.
