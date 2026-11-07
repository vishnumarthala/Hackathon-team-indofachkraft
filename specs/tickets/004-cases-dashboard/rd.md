# 004: Cases dashboard and case pages

**Status:** draft
**Mode:** solo
**Runs:** waits for 001: needs the scaffold, lib/db.ts, lib/http.ts, lib/audit.ts and the cases table

## Summary

The therapist's home: a list of cases, a form to create a case (the "booking"), and a case page with
tabs (Overview, Brief, Sessions, Report, Referral) that later tickets fill in. This is the frame every
other therapist screen plugs into.

## Functional requirements

- **FR-1** - `/dashboard`: `<h1>Cases</h1>`, a link `New case` to `/cases/new`, and a table with
  columns `Child`, `Age`, `Language`, `Status`, `Created`, newest first. Each row's child cell links to
  `/cases/<id>`. Age shows `<n> months` or `-`. Language shows `English`, `Hindi` or `Telugu`. Created
  shows `YYYY-MM-DD HH:mm` (Europe/Berlin). With no cases: `No cases yet. Create the first one.`
- **FR-2** - `/cases/new` form with labelled fields: `Child alias` (required), `Child age (months)`,
  `Parent alias` (required), `Parent email`, `Parent phone (WhatsApp)`, `Language` (select: English,
  Hindi, Telugu; default English), `Therapist name` (default `Demo Therapist`), and the hint
  `Use made-up names only (synthetic data).` Button `Create case` posts to `POST /api/cases`; on 201 it
  navigates to `/cases/<id>`; on 400 it shows each field's message under that field.
- **FR-3** - `POST /api/cases` validates (strings trimmed): `child_alias` 1-60 chars
  (`Child alias is required` / `Child alias must be at most 60 characters`); `child_age_months`
  optional integer 12-216 (`Age must be between 12 and 216 months`); `parent_alias` 1-60
  (`Parent alias is required` / `Parent alias must be at most 60 characters`); `parent_email` optional
  valid email (`Enter a valid email`); `parent_phone` optional matching `^\+?[0-9 ]{7,20}$`
  (`Enter a valid phone number`); `language` one of `en`,`hi`,`te` (`Choose English, Hindi or Telugu`);
  `therapist_name` optional, at most 60 (`Therapist name must be at most 60 characters`; default
  `Demo Therapist`). Empty or whitespace-only strings count as not given. 400 body: `{ error: "Invalid request", details: { <field>: "<message>" } }`. 201 `{ case }`.
  Writes audit `case.created` (actor `therapist`).
- **FR-4** - `PATCH /api/cases/:id` accepts any of `facp_score` (integer 0-100 or null; message
  `FACP score must be between 0 and 100`), `language`, `parent_email`, `parent_phone` with the same
  rules; an empty string for `parent_email`/`parent_phone` or `null` clears the field; a body with none
  of these keys -> 400 `{ error: "Nothing to update" }`; 404 `{ error: "Case not found" }` for an
  unknown or non-uuid id; 200 `{ case }`; audit `case.updated` (actor `therapist`, entity `case`,
  details `{ changed: [<field names whose value changed>] }`), skipped when nothing changed.
- **FR-5** - `app/cases/[id]/layout.tsx`: header with the child alias (h1), `<age> months` (if set),
  language name and a status badge (`Booked`, `Intake done`, `In assessment`, `Referred`); a tab nav
  with links `Overview` (`/cases/<id>`), `Brief`, `Sessions`, `Report`, `Referral`
  (`/cases/<id>/<tab>`); the current tab has `aria-current="page"`: `Overview` only on exactly
  `/cases/<id>`, every other tab on its path and all sub-paths (e.g. `Sessions` on
  `/cases/<id>/sessions/new` and `/cases/<id>/sessions/<recordingId>`). Unknown or non-uuid id ->
  `notFound()`, rendered by `app/cases/not-found.tsx` (a `notFound()` thrown in a layout is caught by
  the parent segment's boundary) showing `Case not found` and a link `Back to cases` to `/dashboard`.
- **FR-6** - Overview `/cases/<id>`: parent alias, parent email, parent phone, therapist, created date;
  a form with input `FACP score (0-100)` (`name="facp_score"`) prefilled with the saved value (empty when null) and button
  `Save FACP score` (PATCH; an empty input sends `null`; shows `Saved` on success or the error message); a `Next step` card with exactly one of:
  booked -> `Send the parent an intake link from the Brief tab.`;
  intake_done -> `Review the brief, then upload session 1 from the Sessions tab.`;
  in_assessment -> `Confirm the ISAA items in the latest session.`;
  referred -> `Referral sent. The specialist can ask questions about the case.`
- **FR-7** - Sessions `/cases/<id>/sessions`: link `New session` to `/cases/<id>/sessions/new`; a list
  of `kind = 'session'` recordings ordered by `session_number`: `Session <n>`, status, created date and
  a link `Open` to `/cases/<id>/sessions/<recordingId>`; empty state `No sessions yet.`
- **FR-8** - Placeholder pages `/cases/<id>/brief`, `/cases/<id>/report`, `/cases/<id>/referral`, each
  an `<h2>` with the tab name and the text `Coming soon.` (later tickets replace them).
- **FR-9** - Read helpers in `lib/queries/cases.ts`: `listCases()`, `getCase(id)` (null when not found
  or id is not a uuid), `listSessions(caseId)`.

## Non-functional requirements

- **NFR-1** - Every page that reads the DB exports `dynamic = "force-dynamic"`; `npm run build` passes
  without `.env.local`.
- **NFR-2** - Every input has a `<label>` (agent-browser can fill by label).
- **NFR-3** - Pages work at 375 px width without horizontal scrolling (table scrolls inside its own box).

## Affected areas

- `app/dashboard/page.tsx`, `app/cases/new/page.tsx` (new)
- `app/cases/[id]/layout.tsx`, `app/cases/[id]/page.tsx`, `app/cases/[id]/sessions/page.tsx`,
  `app/cases/not-found.tsx` (new)
- `app/cases/[id]/brief/page.tsx`, `app/cases/[id]/report/page.tsx`, `app/cases/[id]/referral/page.tsx` (new, placeholders)
- `app/api/cases/route.ts`, `app/api/cases/[id]/route.ts` (new)
- `components/case/*.tsx` (new: form, tabs, status badge, FACP form)
- `lib/queries/cases.ts`, `lib/cases/validation.ts` (new)
- `tests/cases-validation.test.ts` (new)

## Don't touch

- `app/layout.tsx`, `app/page.tsx`, `lib/types.ts`, `lib/db.ts`, `supabase/migrations/**`, `package.json`

## Out of scope

- Deleting or archiving cases, search, pagination, login.
- Intake link UI (009), brief (010), session review (007), upload (008), report (011), referral (012).
- Showing FACP band or ISAA score (007 shows them).

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Login? | None; open pages, demo banner from 001 | grill D-1 |
| D-2 | Time zone for dates | Europe/Berlin | hackathon venue; one time zone |
| D-3 | Validation errors shape | `lib/http.parseJson` (001) already returns `details` as a field -> message map; define the messages above in the Zod schema | the form shows messages per field |
| D-4 | Tabs for later tickets | Placeholders now so later tickets only replace their own page file | avoids parallel edits of the layout |

## Open questions

None.
