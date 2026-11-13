# 021: Child health profile

**Status:** done
**Mode:** solo
**Runs:** waits for 020: needs `children`, guardian links and child access helpers

## Summary

Guardians keep one health profile per child (allergies, medications, conditions, birth and
developmental history, emergency contact) that treating providers can read. It is the source of the
allergy check on prescriptions later (039). Versioned with optimistic concurrency and full history.

## Functional requirements

- **FR-1** - Migration `<ts>_health_profile.sql`:
  `child_health_profiles(child_id pk -> children on delete cascade, blood_group text null check in
  ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown'), allergies jsonb not null default '[]',
  medications jsonb not null default '[]', conditions jsonb not null default '[]', birth_history text
  (<= 2000), developmental_history text (<= 4000), emergency_contact_name text (<= 80),
  emergency_contact_phone text (E.164), version int not null default 1, updated_by uuid, updated_at)`;
  `child_health_profile_history(id, child_id, version, snapshot jsonb, changed_by, changed_at)` written by
  a trigger on every update (append-only). RLS on both.
- **FR-2** - Zod schemas in `lib/health/schema.ts`: allergy `{ substance (1-80), reaction (<= 200),
  severity: "mild" | "moderate" | "severe" | "unknown" }` (max 30); medication `{ name (1-80), dose (<= 40),
  frequency (<= 60), since?: "YYYY-MM" }` (max 30); condition `{ name (1-120), since?: "YYYY-MM",
  notes? (<= 300) }` (max 30). A special allergy value `{ substance: "No known allergies" }` is allowed only
  as the single entry (`NKA`).
- **FR-3** - `GET /api/family/children/:id/health` (`requireChildGuardian`) -> 200 `{ profile }` (empty
  profile with `version: 0` if none). `PUT /api/family/children/:id/health` body = full profile +
  `version` -> 200 `{ profile }`; stale `version` -> 409 `{ error: "This profile was changed by someone
  else. Reload to see the latest version." }`; validation -> 400 with field details. Audit
  `health_profile.updated` with changed top-level fields only (no values).
- **FR-4** - Guardian UI `/family/children/[id]/health`: sections `Allergies`, `Medicines`,
  `Conditions`, `Birth history`, `Development so far`, `Emergency contact`, `Blood group`; repeatable
  rows with `Add allergy` / `Add medicine` / `Add condition` and `Remove`; a checkbox `No known allergies`;
  `Save` and `Last updated <date> by <name>`. Notice text: `Providers treating <child> at organisations
  where <child> has an open case can see this profile.`
- **FR-5** - Provider read: `GET /api/cases/:id/health` (017 `requireCaseAccess`) -> 200
  `{ profile, updated_at }` for the case's child; 404 if no profile. Case workspace gets a read-only
  `Health` tab with an allergy banner at the top of the case header when severe allergies exist:
  `Severe allergy: <substance>`. Providers cannot edit (they ask the guardian; editing by providers is out of scope).
- **FR-6** - History: `/family/children/[id]/health/history` lists versions (date, by, changed sections);
  guardian can view a past snapshot read-only.
- **FR-7** - `lib/health/summary.ts` `healthSummary(profile)` returns a short plain-text summary
  (`Allergies: ...; Medicines: ...; Conditions: ...`) used by intake briefs, scribe and Rx (later tickets).

## Non-functional requirements

- **NFR-1** - Access follows rule 2: org providers see the profile only through an accessible case of
  their own org for that child; cross-org without a case -> 404. No caching across users.
- **NFR-2** - Translated (en/hi/te); free-text values are shown as entered (no translation).
- **NFR-3** - Health data never appears in notifications, logs or audit details.

## Affected areas

- `supabase/migrations/<ts>_health_profile.sql` (new)
- `lib/health/schema.ts`, `lib/health/summary.ts`, `lib/queries/health.ts` (new)
- `app/api/family/children/[id]/health/route.ts`, `app/api/cases/[id]/health/route.ts` (new)
- `app/family/children/[id]/health/**` (new), case workspace `Health` tab + allergy banner (new component)
- `messages/*.json`; `tests/health-profile.test.ts` (new)

## Don't touch

- Consent tables/logic (020), existing migrations, ISAA/extraction, `BOARD.md`

## Out of scope

- Growth charts, vaccinations, lab results (dropped from old DRnME), provider edits, drug database / coded allergies (SNOMED).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Feature kept | Health profile is in scope | plan §2 "Old DRnME features kept" |
| D-2 | Who edits | Guardian only; providers read | single source of truth, avoids clinical conflicts |
| D-3 | Who reads | Providers with an accessible case for the child in their org | rule 2 |
| D-4 | Concurrency | `version` optimistic lock + history trigger | two guardians may edit |

## Open questions

- Should a separate consent feature gate provider read access to the health profile? Proposed: no -
  an open case at that org is the guardian-initiated treatment relationship; revisit at legal review.
