# 040: Follow-up agent ("ask about my child's plan")

**Status:** draft
**Mode:** solo
**Runs:** waits for 026, 033, 039: grounds answers on published home programs/plans (025/026) and signed prescriptions (039); reuses the screen's red-flag safety handling (033)

## Summary

In the family portal, a guardian can ask questions - by text or by voice (English) - about their child's
**published** plan, home program, shared reports and signed prescriptions, and gets short answers with
citations to those documents. Built on `lib/ask` (013). It retrieves only versions the guardian is
authorised to see (rule 9), never changes doses, never diagnoses, and escalates red flags to 108/112.

## Functional requirements

- **FR-1** - Context builder `lib/followup/context.ts` `loadGuardianContext(guardianUserId, childId)`:
  latest `published_versions` rows with `visible_to_guardian = true` for the child across orgs where the
  guardian link is active: `iep_plan`, `home_program`, `report` (shared ones), `assessment` (shared),
  `prescription` (signed, not void); plus home-activity adherence summary. Nothing else (no drafts,
  transcripts, facts, messages). Max 60,000 chars (013 limit), newest first.
- **FR-2** - `POST /api/family/children/:id/ask` `{ question (3-500) }` (`requireChildGuardian`; consent
  `ai_follow_up` (020) else 422) -> 200 `{ found, answer, citations: [{ entity_type, entity_id, version,
  label, excerpt }], safety?: "red_flag" | "medical_advice" }`. Prompt `prompts/follow-up.md` rules:
  answer only from context; if not found say `I couldn't find that in your child's shared plans. Please
  ask your provider using Messages.`; never suggest changing, stopping or adding medicines or doses -
  answer `Please don't change any medicine without talking to the prescriber.` plus a Messages link; never
  diagnose; English answers (UI chrome translated). Rate limit 30 questions/day/guardian.
- **FR-3** - Red flags: questions matching the shared red-flag classifier (033 codes plus `medicine
  overdose`, `breathing`, `unconscious`, `suicidal`) bypass the model and return the 108/112 message
  with `safety: "red_flag"`; audit `followup.red_flag` (no question text).
- **FR-4** - UI `/family/children/[id]/ask`: input `Ask about <child>'s plan`, suggested questions
  (`What should we practise this week?`, `When is the next review?`, `How do I give the medicine?`),
  answers with citation chips opening the cited published document at the version shown; disclaimer
  `AI answers from your child's shared plans. It is not medical advice.`
- **FR-5** - Voice: `Ask by voice` uses ElevenLabs agent `DoctorNearMe Follow-up` (English) with a
  server tool `answer_question { question }` -> same handler as FR-2 bound to a 15-minute signed
  session token for (guardian, child); the agent speaks the returned answer only. Guide
  `docs/elevenlabs-followup-agent.md`. The CSP allowlist (019/041) gains the ElevenLabs SDK origins for
  this route only.
- **FR-6** - Logging: `followup_questions(id, child_id, guardian_user_id, question, answer, citations,
  safety, created_at)` retained 90 days (041 registry); visible to the guardian as history.

## Non-functional requirements

- **NFR-1** - Retrieval is authorisation-first: context loader is tested to never return unpublished,
  non-guardian-visible, voided or other-child content.
- **NFR-2** - p95 answer < 6 s (DEMO fixtures for tests).

## Affected areas

- `lib/followup/**` (new), `lib/ask/citations.ts` (generalise citation kinds), `prompts/follow-up.md` (new)
- `app/api/family/children/[id]/ask/route.ts`, `app/api/agents/followup/**`, `app/family/children/[id]/ask/**` (new)
- `supabase/migrations/<ts>_followup.sql` (new), `docs/elevenlabs-followup-agent.md` (new)
- `lib/privacy/registry.ts`, `lib/privacy/third-party-allowlist.ts`, `.env.example`, `messages/*.json`
- `tests/followup-context.test.ts`, `tests/followup-safety.test.ts` (new)

## Don't touch

- Specialist `ask` (013) behaviour, published-version schema, existing migrations, `BOARD.md`

## Out of scope

- Hindi/Telugu voice, proactive reminders/check-ins by the agent, answering from provider notes not shared.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Grounding | Only guardian-authorised published versions | rule 9 |
| D-2 | Reuse | `lib/ask` pattern and citation UI | plan §4 "reuse `lib/ask`" |
| D-3 | Language | Agent English | plan §2 |
| D-4 | Safety | Red flags -> 108/112; no dose changes | plan §2 "Safety" |

## Open questions

None.
