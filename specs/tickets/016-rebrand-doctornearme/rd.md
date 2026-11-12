# 016: Rebrand to DoctorNearMe (user-facing)

**Status:** done
**Mode:** solo
**Runs:** alongside

## Summary

CareThread becomes **DoctorNearMe**, an autism and early-intervention platform. The existing
therapist workflow (intake call -> session -> ISAA -> report -> referral) is kept as the
**Child Development** module, "powered by the CareThread engine". This ticket changes every
user-facing name; internal identifiers stay so nothing else breaks. Decision record:
[specs/grill/doctornearme-mvp.md](../../grill/doctornearme-mvp.md).

## Functional requirements

- **FR-1** - Every user-facing occurrence of `CareThread` in `app/`, `components/`, `lib/`, `prompts/`
  (page text, metadata titles/descriptions, aria labels, logo wordmark, email subjects/bodies, intake
  message, AI prompt personas, suggestion label, demo centre name, `.env.example` default sender) reads
  `DoctorNearMe`.
- **FR-2** - Root metadata: title `DoctorNearMe`, description
  `Autism and early intervention care near you, with an AI assistant for therapists.`
- **FR-3** - Landing metadata title `DoctorNearMe - autism and early intervention, with an AI assistant for therapists`.
  The landing subtitle names the Child Development module and says it is powered by the CareThread engine.
- **FR-4** - The in-app header (`SiteChrome`) shows `DoctorNearMe` with a secondary label
  `Child Development` (module name).
- **FR-5** - Footer: `© 2026 DoctorNearMe. Built for early intervention teams in India.` and
  `Built on ElevenLabs and Google Gemini. DoctorNearMe supports clinicians; it is not a diagnosis.`
- **FR-6** - `docs/elevenlabs-agent.md`, `docs/system-design.md`, `docs/team-workflow.md` and
  `docs/pitch-video-shots.md` use the new brand; the agent guide names the agent
  `DoctorNearMe Child Development Intake` and its first message/system prompt say DoctorNearMe. The guide
  lists "update the published agent's name, first message and prompt" as a manual step.
- **FR-7** - Tests asserting branded strings are updated to the new strings.

## Non-functional requirements

- **NFR-1** - Internal identifiers are unchanged: `__carethread*` globals, `is_carethread_admin()`
  (in an applied migration), `carethread:demo-call-ended` event, `package.json` name, Supabase
  `project_id`, the ElevenLabs agent ID.
- **NFR-2** - Historical records (`specs/tickets/001-015/**`, `specs/grill/carethread-mvp.md`,
  `CareThread Hackathon Team Plan.*`, `video/`) are not edited.

## Affected areas

`app/**`, `components/**`, `lib/env.ts`, `lib/scoring.ts`, `lib/intake/message.ts`,
`lib/elevenlabs/agent.ts`, `app/api/cases/[id]/refer/route.ts`, `prompts/*.md`, `tests/*`, `.env.example`, `docs/*.md`.

## Don't touch

`supabase/migrations/**`, `package.json`, `supabase/config.toml`, historical specs, `video/`.

## Out of scope

New logo artwork, new pages, i18n (018), re-configuring the live ElevenLabs agent (manual step).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Rebrand depth | User-facing text, metadata, emails, prompts, docs; code names stay | grill: rebrand depth |
| D-2 | Module name | `Child Development (powered by CareThread engine)` | grill: module name |

## Open questions

None.
