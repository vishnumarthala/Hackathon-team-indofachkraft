# Child health profile (ticket 021)

One health profile per child, kept by the guardian (allergies, medicines, conditions, birth and
developmental history, emergency contact, blood group). Providers treating the child read it; nobody but
a linked guardian edits it (D-2). Later tickets read it: pre-consult briefs (035), AI scribe (038) and the
e-prescription allergy / current-medicine check (039).

## Model (`supabase/migrations/20261113002100_health_profile.sql`)

| Table | What |
|-------|------|
| `child_health_profiles` | `child_id` (pk, -> `children` on delete cascade), `blood_group` (`A+`..`O-`, `unknown`, null), `allergies` / `medications` / `conditions` (jsonb arrays, <= 30 each), `birth_history` (<= 2000), `developmental_history` (<= 4000), `emergency_contact_name` (<= 80), `emergency_contact_phone` (E.164), `version`, `updated_by`, `updated_at`. No row = empty profile, `version: 0`. |
| `child_health_profile_history` | `child_id, version, snapshot, changed_fields, changed_by, changed_at`; one row per saved version (including the first), written by the trigger `child_health_profiles_write_history`. Append-only: a trigger blocks update/truncate for every role, no role may insert/update/delete directly; rows only disappear with the child (FK cascade, e.g. account deletion in 041). |

- **Versioning**: triggers own `version` and `updated_at` (insert -> 1, every update -> +1), whoever writes.
- **Save**: `save_child_health_profile(child, user, expected_version, profile jsonb)` (security definer,
  service role only, one transaction): checks the active guardian link (defence in depth), inserts
  (`expected_version = 0`) or updates `where version = expected` under a row lock, writes the audit row
  `health_profile.updated { fields, version }` (field names only), returns `saved` / `conflict` /
  `not_found`. If the audit insert fails nothing is saved (strict).
- `changed_fields` / audit `fields` are top-level names: `blood_group`, `allergies`, `medications`,
  `conditions`, `birth_history`, `developmental_history`, `emergency_contact_name`, `emergency_contact_phone`.
  Never values (NFR-3).
- **RLS** (browser reads only): profile readable by the child's guardians and by providers who can access a
  case of the child (`can_read_child_via_org`, 022 rule); history readable by guardians only. No client writes.

## Shapes (`lib/health/schema.ts`, safe in the browser)

```ts
Allergy    = { substance: 1-80, reaction: <= 200 (default ""), severity: "mild"|"moderate"|"severe"|"unknown" (default "unknown") }
Medication = { name: 1-80, dose: <= 40, frequency: <= 60, since?: "YYYY-MM" }
Condition  = { name: 1-120, since?: "YYYY-MM", notes?: <= 300 }
```

- **NKA**: `{ substance: "No known allergies" }` (case-insensitive) is allowed only as the single allergy
  entry; it is stored as `{ substance: "No known allergies", reaction: "", severity: "unknown" }`.
  Mixed with other allergies -> 400 `{ allergies: "No known allergies cannot be combined with other allergies" }`.
  An empty `allergies` array means **not recorded**, not "no allergies".
- Phone: E.164; a 10-digit Indian mobile is normalised to `+91...`.
- Free text is trimmed, empty -> null, and shown as entered (never translated, NFR-2).
- Helpers: `HealthProfilePutSchema`, `emptyHealthProfile`, `hasNoKnownAllergies`, `listedAllergies`,
  `severeAllergies`, `sectionsOf`, `healthFieldErrors` (full paths like `allergies.0.substance`),
  `HEALTH_CONFLICT_ERROR`.

## API

| Route | Gate | Answer |
|-------|------|--------|
| `GET /api/family/children/:id/health` | `requireGuardian` + `requireChildGuardian` (other families 404, providers 403) | 200 `{ profile }` (`version: 0` if none) |
| `PUT /api/family/children/:id/health` | same | body = full profile + `version` the editor started from -> 200 `{ profile }`; stale -> 409 `{ error: "This profile was changed by someone else. Reload to see the latest version." }`; invalid -> 400 `{ error, details: { "<path>": message } }` |
| `GET /api/cases/:id/health` | `requireCaseAccess` (owner/admin of the case's org or assigned member; otherwise 404; guardians 403) | 200 `{ profile, updated_at }`; 404 `No health profile yet` |

All three answer `Cache-Control: private, no-store` (NFR-1). No notifications are sent for health edits.

## Reading it from other features (035, 038, 039)

Gate first (e.g. `requireCaseAccess(caseId)`), then (`lib/queries/health.ts`, server only):

```ts
import { getHealthProfile, getHealthProfileForCase, getPrescribingHealthFacts } from "@/lib/queries/health";
import { healthSummary } from "@/lib/health/summary";

const facts = await getPrescribingHealthFacts(childId);
// { recorded, noKnownAllergies, allergies: Allergy[] (without the NKA marker), medications, version, updatedAt }
// recorded === false -> allergies are UNKNOWN: do not treat as "no allergies" in an Rx check.

healthSummary(await getHealthProfileForCase(caseId));
// "Allergies: Peanut (severe, hives); Medicines: Synthetic syrup 5 ml twice daily; Conditions: not recorded"
```

`healthSummary` is English on purpose (prompts and clinical documents). Store `version` with anything derived
from the profile (e.g. the Rx) so it is clear which version was checked. Do not log the summary.

## UI

- Guardian: `/family/children/[id]/health` (linked from the child page): sections Allergies, Medicines,
  Conditions, Birth history, Development so far, Emergency contact, Blood group; repeatable rows with
  `Add allergy` / `Add medicine` / `Add condition` and `Remove`; `No known allergies` checkbox (ticking it
  while allergies are listed is a validation error); `Save`; `Last updated <date> by <name>`; the notice
  `Providers treating <child> at organisations where <child> has an open case can see this profile.`
  A 409 shows the conflict message and `Reload`. Component: `components/health/HealthProfileForm.tsx`.
- History: `/family/children/[id]/health/history` (version, date, by, changed sections) and
  `/family/children/[id]/health/history/[version]` (read-only snapshot).
- Provider: case workspace `Health` tab (`app/cases/[id]/health`, read only) and the banner
  `Severe allergy: <substance>` at the top of every case page header
  (`components/health/SevereAllergyBanner.tsx`, in `app/cases/[id]/layout.tsx`).

## Sharing (022)

The profile belongs to the child, not to an organisation. The `health_profile` share scope is registered
(`lib/sharing/loaders/health_profile.ts`): for an active grant it lists one item (id = child id) per source
org, opened as markdown in `Shared with us`. Because grants exist only between organisations that both have
a case for the child, the grantee can also read the profile through its own case (FR-5); the loader just
makes the shared view show it.

## Tests

`tests/health-profile.test.ts` (schema limits, NKA, summary, API, 409 and a concurrent race, history,
append-only, audit without values, provider read and authz negatives, RLS, share loader). DB cleanup:
`purgeSyntheticChildren` also removes health rows (replica mode skips FK cascades).
