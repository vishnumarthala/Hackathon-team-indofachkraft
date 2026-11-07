# 004: Cases dashboard and case pages - Results

Branch: ticket/004-cases-dashboard (merged into `int/c-frontend`). Tested against the shared Supabase cloud project.

| Check | Result | Evidence |
|-------|--------|----------|
| lint, typecheck, `npm test` | PASS | incl. `tests/cases-validation.test.ts` (E-8) |
| E-1 create case in the UI | PASS | browser: form -> `/cases/<uuid>`, header `40 months`, `Telugu`, `Booked`, 5 tabs, next step text |
| E-2 dashboard lists the case | PASS | child, age, language, status columns; link to the case |
| E-3 API validation | PASS | exact 400 body; valid body 201 |
| E-4 FACP and PATCH rules | PASS | UI `Saved`; DB 55; 101 -> 400 message; `{}` -> `Nothing to update`; email cleared to null; audits `case.created`, `case.updated` with `changed` |
| E-5 sessions tab, placeholders | PASS | `No sessions yet.`, `New session`, `Coming soon.`; `/sessions/new` is a 404 until 008 adds it |
| E-6 unknown/malformed ids | PASS | 404, 404 + `Case not found`, PATCH 404 |
| E-7 375 px | PASS | no horizontal scroll on `/dashboard` |
