# 050: Parent-first home page and Indian statistics - Results

Branch: `ticket/050-parent-landing`. Tested against the local Supabase stack in slot 3 (`supabase_db_dnmslot3`,
env from `dnm-db.sh 3 … env`), `DEMO_MODE=true`, dev server on port 3030, headless Chromium (playwright-core)
with `prefers-reduced-motion: reduce` so the scroll-reveal sections show in full-page screenshots. No migrations.
Synthetic data only.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | exit 0, no problems |
| `npm run typecheck` | PASS | exit 0 (`next typegen && tsc --noEmit`) |
| `npx vitest run` (slot 3 stack, DB suites running) | PASS | 97 files, 1614 passed, 11 skipped. The skips existed before this ticket: 10 opt-in `CT_DB_TESTS=1` cases in `intake-completion.test.ts` (that suite reads `.env.local`, which this worker may not open) and the `NO_TRACKING_BASE_URL` live crawl |
| `npm run build` | PASS | exit 0; `ƒ /` and `ƒ /for-centres` in the route list |
| Page test: `/` renders the parent hero, links to `/screen`, `/find`, `/family/children/claim` | PASS | `tests/parent-landing.test.ts` (10 tests): hero copy; check-in link comes before find in the hero; clinic-code link; voice link `/family/login?next=%2Fscreen%3Fvoice%3D1`; no `Book a demo` above the footer; How it works strip (Check-in, Find, Visit, Practise at home); trust row; four statistics and the three source URLs; Telugu render; title and canonical |
| Page test: `/for-centres` renders the existing therapist landing with `Book a demo` | PASS | same file: hero badge "For early intervention therapists", `Book a demo` → `/book-demo`, nav `For centres` with `aria-current="page"`, Indian statistics with sources, no CDC / Höfer / German / Harstad / Dawson, recorded sample (`sample-intake-call.mp3`) for visitors, title unchanged (`landing.meta.title`) |
| No CDC, Höfer or "German" strings in the landing keys | PASS | `parent-landing.test.ts` "landing copy" checks `landing.*`, `nav.*`, `footer.*` in en/hi/te for CDC, Höfer, German/Deutsch/जर्मन/జర్మన్, Germany, US/अमेरिका/అమెరికా, Harstad, Dawson |
| i18n key parity | PASS | `tests/i18n-keys.test.ts` (parity, placeholders, "not a diagnosis" rule, `messages/REVIEW.md` regenerated with `npx tsx scripts/i18n-review.ts`; new rows `pending`) |
| FR-4 metadata | PASS | `curl /` → `<title>DoctorNearMe – child development check-in and therapists near you (Hyderabad)</title>`, canonical `/`; with `dnm_locale=te` the Telugu title; `/for-centres` keeps `DoctorNearMe - autism and early intervention, with an AI assistant for therapists` |
| FR-5 no new third-party scripts | PASS | `tests/no-tracking.test.ts` new block scans the module graph of `app/page.tsx` and `app/for-centres/page.tsx`; `curl /` has no `<script src>` outside `/_next/` |
| E-1 parent at 390 px in Telugu | PASS | 390×844, `dnm_locale=te`: h1 128–242 px, `Start a free check-in` 381–437, `Find a therapist near you` 449–505, voice link 517–561, all inside 844 px; no horizontal scroll (scrollWidth 390). The statistics block shows `మూలాలు:` with the three source links. Same check in en (buttons end at 467) and hi (467). `evidence/home-390-te-fold.png`, `home-390-te-full.jpg`, `home-390-te-stats.png`, `home-390-hi-fold.png` |
| E-2 centre owner | PASS | 1440 px: `/` → nav `For centres` → `/for-centres` (therapist hero visible) → nav `Book a demo` → `/book-demo` (h1 "See your next assessment document itself."). 390 px: menu → `For centres` → `/for-centres`. `evidence/e2-book-demo-1440.png` |
| Nav fits at desktop widths | PASS | nav content width ≤ container at 1280 and 1440 px in en/hi/te on both pages, and at 375/640/768/1024 px (no overflow) |
| Screenshots 390 px and 1440 px | PASS | `evidence/home-390-en-fold.png`, `home-390-en-full.jpg`, `home-1440-en-fold.png`, `home-1440-en-full.jpg`, `for-centres-390-en-fold.png`, `for-centres-390-en-full.jpg`, `for-centres-1440-en-fold.jpg`, `for-centres-1440-en-full.jpg` |

## Deviations

- **No `hreflang` alternates (FR-4 "if 018 supports them").** Ticket 018 keeps the UI language in a cookie, so
  en/hi/te share one URL and there is nothing to point `hreflang` at. Both pages set a canonical URL instead.
- **US trial figures removed from `/for-centres`.** The "solution" block quoted Harstad et al. 2023 and Dawson et al.
  2010 (US studies). D-2 says Indian sources only and the PMF sources list has no Indian figure for that claim, so the
  two cards and their source line were removed (the section keeps its title and language row). The four problem
  cards and the "1 in 31 US / 1 in 100 worldwide" row were replaced by the shared Indian statistics block.
- **"Diagnosis" wording.** The copy rule (018, `i18n-keys.test.ts`) bans "diagnosis" except "not a diagnosis", so the
  4.6-year figure reads "average age at which autism was identified". Hindi uses पहचान, Telugu గుర్తించిన.
- **German removed from landing copy.** Besides the statistics, the "German coming soon" mentions (`how.intakePoint3`,
  `faq.a5`, the `Deutsch` chip in the language row) and "pilot centres in Germany and India" (`cta.eyebrow`) were
  changed to en/hi/te only and Hyderabad. `bookDemo.*` (Germany as a country option) is unchanged because `/book-demo`
  is out of scope (FR-1).
- **Desktop nav shortened.** With the new items the bar wrapped at 1440 px. Desktop now shows: parents' bar How it
  works, Find, For centres + CTA `Start free check-in`; centres' bar AI intake call, How it works, FAQ, For centres
  (current), For parents + CTA `Book a demo`. The mobile menu lists every link (including The problem, Who it's for,
  Find, Developmental check-in). `Log in` shows from 768 px (it is in the mobile menu below that).
- Small changes outside the listed affected areas, needed for the move: `components/SiteChrome.tsx` (`/for-centres`
  is a marketing path without the app banner), `tests/no-tracking.test.ts` (scan of the two pages), docs.

## Notes

- Hindi and Telugu copy was drafted by this worker (not native-speaker reviewed); the rows are `pending` in
  `messages/REVIEW.md` like the rest of the catalogue.
- The statistics wording follows rd FR-3. "1 in 8 … under 10" is the INCLEN 2–9-year figure; the 1.4 billion
  population figure comes from the rd, not from the RCI document.
- New helpers: `components/landing/IndianStats.tsx` (`IndianStats`, `INDIAN_STAT_SOURCES`) and
  `components/landing/links.ts` (`PARENT_LINKS`). `SiteNav` takes `variant="parents" | "centres"` (default parents).
- New message keys: `landing.parents.*`, `landing.stats.*`, `nav.forCentres`, `nav.forParents`, `nav.startCheckIn`,
  `footer.familySignIn`. Removed: `landing.problem.stat*/prevalence*/sources`, `landing.solution.evidence*/sources/
  soon/german`, `footer.product`, `footer.getStarted`.
- Figma: the `/for-centres` frame in "Screens · Public & parents" is a designer task (rd affected areas); the
  design-system screen index lists both routes.
- No migrations, env vars or API changes.
