# 018: i18n foundation (English, Hindi, Telugu)

**Status:** done
**Mode:** solo
**Runs:** alongside (no ticket dependencies; 016 is merged, so translate the DoctorNearMe copy as it is now)

## Summary

DoctorNearMe's UI must be usable in English, Hindi and Telugu (Hyderabad pilot). This ticket adds the
i18n plumbing every later ticket uses: a locale resolver, typed message catalogues, a `t()` helper for
server and client components, a language switcher, locale-aware date/number/currency formatting in
the viewer's own time zone (from their browser; fallback `Asia/Kolkata`), and Indic fonts. It translates the shared shell (header, footer, banner), `/login`,
the landing page and the public intake page. Clinical content (ISAA items, AI-generated reports,
prompts) is **not** translated here. No URL prefixes: the locale lives in a cookie and the user profile.

## Functional requirements

- **FR-1** - `lib/i18n/config.ts` exports `LOCALES = ["en", "hi", "te"] as const`, `type Locale`,
  `DEFAULT_LOCALE = "en"`, `LOCALE_LABELS = { en: "English", hi: "हिन्दी", te: "తెలుగు" }`,
  `HTML_LANG = { en: "en-IN", hi: "hi-IN", te: "te-IN" }`, `DEFAULT_TIME_ZONE = "Asia/Kolkata"` and
  `isLocale(value): value is Locale`.
- **FR-2** - Message catalogues `messages/en.json`, `messages/hi.json`, `messages/te.json`: nested JSON,
  keys in dot paths grouped by surface (`common.*`, `nav.*`, `footer.*`, `banner.*`, `login.*`,
  `landing.*`, `intake.*`, `language.*`, `errors.*`). `en.json` is the source of truth; `lib/i18n/keys.ts`
  derives `type MessageKey` from it so `t("unknown.key")` is a type error.
- **FR-3** - Locale resolution `getLocale(): Promise<Locale>` (server, `lib/i18n/server.ts`), in order:
  (1) cookie `dnm_locale` if valid; (2) signed-in user's `user_profiles.preferred_locale` if not null;
  (3) first supported language in `Accept-Language` (`hi*` -> `hi`, `te*` -> `te`, `en*` -> `en`);
  (4) `en`. Pages under `/intake/<token>` with no cookie use the case `language` as step (2b).
- **FR-4** - `getT(namespace?)` (server) and `useT()` (client, via a `I18nProvider` in the root layout
  that receives only the active locale's messages) return `t(key, vars?)`. Interpolation uses
  `{name}` placeholders; a missing variable renders the placeholder literally and logs a warning in
  development. A key missing in `hi`/`te` falls back to `en` (development: `console.warn` once per key).
  Plural forms use `Intl.PluralRules` with keys suffixed `_one` / `_other`.
- **FR-5** - Formatting helpers in `lib/i18n/format.ts`: `formatDate(d, locale, style: "short"|"long")`,
  `formatDateTime(d, locale)`, `formatTime(d, locale)`, `formatNumber(n, locale)`,
  `formatInr(paise, locale)` (e.g. `₹1,500` / Indian digit grouping `₹1,50,000`). All take the
  viewer's `timeZone` (FR-5a) and `HTML_LANG[locale]`; digits stay Latin (`numberingSystem: "latn"`).
- **FR-5a** - Viewer time zone (product decision 2026-11-12: "based on the user location").
  `getTimeZone(): Promise<string>` (server), in order: (1) cookie `dnm_tz` if it is a valid IANA zone
  (checked with `Intl.DateTimeFormat(undefined, { timeZone })`); (2) signed-in user's
  `user_profiles.time_zone`; (3) `DEFAULT_TIME_ZONE`. A client component `TimeZoneSync` in the root layout
  reads `Intl.DateTimeFormat().resolvedOptions().timeZone`; when it differs from the cookie it calls
  `POST /api/locale` `{ time_zone }` (sets `dnm_tz`, updates the profile when signed in) and then
  `router.refresh()` once. Every formatted date/time shows the zone abbreviation when it is not the
  viewer's default display (e.g. `10:30 IST`), so a clinic time is never ambiguous. Storage stays UTC
  (`timestamptz`). Existing pages switch to these helpers: `lib/pilots.ts` `formatBerlin` is replaced by
  `formatDateTime` in the viewer's zone, and `lib/cases/format.ts` date helpers take the viewer's zone.
- **FR-6** - Root layout sets `<html lang={HTML_LANG[locale]}>`; loads Noto Sans, Noto Sans Devanagari
  and Noto Sans Telugu via `next/font/google` (subsets `latin`, `devanagari`, `telugu`, `display: swap`)
  so Hindi/Telugu glyphs never render as boxes.
- **FR-7** - Language switcher in `SiteChrome` (header) and on `/login`, `/intake/<token>`: a `<select>`
  labelled `Language` (label translated) with options `English`, `हिन्दी`, `తెలుగు` (values `en`, `hi`,
  `te`). Changing it calls `POST /api/locale` and refreshes the route (`router.refresh()`), keeping the
  current path and query.
- **FR-8** - `POST /api/locale` (public) body `{ locale }`: invalid -> 400 `{ error: "Invalid request",
  details: { locale: "Choose English, Hindi or Telugu" } }`; else sets cookie `dnm_locale=<locale>`
  (`Path=/`, `SameSite=Lax`, `Max-Age=31536000`, `HttpOnly`, `Secure` in production), and if a user is signed in updates `user_profiles.preferred_locale`; 200
  `{ locale }`. No audit event (not a clinical mutation).
- **FR-9** - Migration `<ts>_i18n_preferred_locale.sql`: `alter table user_profiles add column
  preferred_locale text check (preferred_locale in ('en','hi','te'))` and `add column time_zone text`
  (both nullable, additive; `time_zone` validated server-side as IANA).
- **FR-10** - Translated surfaces (all visible strings, `aria-label`s, `title`s and metadata):
  `SiteChrome` header/nav/footer/banner, `/login`, landing `/` (including metadata title/description),
  `/book-demo` labels and validation messages, public `/intake/<token>` page text, buttons, status and
  error messages. The intake **call language** select stays separate from the UI language (the call
  language defaults to the UI locale when the case has no language).
- **FR-11** - Hindi and Telugu strings are first drafted by the worker, then listed for human review in
  `messages/REVIEW.md` (key, en, hi, te, reviewer, status). The copy rules apply in all locales: no
  equivalent of "diagnose/diagnosis" except "not a diagnosis" (`निदान नहीं` / `నిర్ధారణ కాదు`), no
  "HIPAA compliant".
- **FR-12** - Authoring guide `docs/i18n.md`: how to add a key, naming conventions, plural keys,
  interpolation, what must not be translated (clinical instrument items, AI outputs, product name
  `DoctorNearMe`, engine name `CareThread`), the review workflow, and the rule that every new UI string
  in later tickets goes through `t()`.

## Non-functional requirements

- **NFR-1** - Only the active locale's catalogue is sent to the browser (verify bundle/RSC payload does
  not contain another locale's unique strings).
- **NFR-2** - No layout breaks at 375 px in any locale (Telugu strings are often 30-60% longer):
  header, login and intake page have no horizontal scroll.
- **NFR-3** - Locale resolution adds no extra network round trip for anonymous users (cookie/header
  only); for signed-in users at most one `user_profiles` read per request, reused.
- **NFR-4** - Before coding, read `node_modules/next/dist/docs/01-app/02-guides/internationalization.md`
  and the proxy docs; do not add a `[lang]` segment or a locale redirect in `proxy.ts`.

## Affected areas

- `lib/i18n/config.ts`, `lib/i18n/server.ts`, `lib/i18n/client.tsx`, `lib/i18n/format.ts`, `lib/i18n/keys.ts` (new)
- `messages/en.json`, `messages/hi.json`, `messages/te.json`, `messages/REVIEW.md` (new)
- `app/layout.tsx` (fonts, `lang`, provider), `components/SiteChrome.tsx`, `components/LanguageSwitcher.tsx` (new)
- `app/page.tsx`, `components/landing/**`, `app/book-demo/**`, `app/login/page.tsx`, `app/intake/[token]/**`, `components/intake/IntakeCall.tsx`
- `lib/pilots.ts`, `lib/cases/format.ts`, `app/dashboard/pilots/page.tsx` (viewer time zone), `components/TimeZoneSync.tsx` (new)
- `app/api/locale/route.ts` (new, also accepts `time_zone`), `lib/auth-access.ts` (add `/api/locale` to public API paths)
- `supabase/migrations/<ts>_i18n_preferred_locale.sql` (new)
- `docs/i18n.md` (new)
- `tests/i18n-keys.test.ts`, `tests/i18n-format.test.ts`, `tests/i18n-locale.test.ts` (new)

## Don't touch

- Case workspace pages, ISAA item texts (`lib/isaa.ts`), `prompts/**`, report generation, `lib/types.ts`
- Existing migrations, `package.json` (no i18n library; `next/font` is built in), `BOARD.md`

## Out of scope

- Translating provider workspace pages (each later ticket translates the pages it adds or changes).
- Locale URL prefixes / `hreflang` for public SEO pages (revisit in 029).
- Machine translation of user content (messages, notes, reports).
- Right-to-left scripts, Urdu.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | UI languages | en / hi / te | plan §2 "UI language" |
| D-2 | Locale in URL or cookie | Cookie `dnm_locale` + `user_profiles.preferred_locale`; no URL prefix | keeps all existing routes and links (`/intake/<token>`, `/specialist/<token>`) stable |
| D-3 | Library | No dependency; small typed `t()` over JSON catalogues | App Router guide pattern; fewer moving parts for agent-built code |
| D-4 | Clinical content | Not translated in this ticket | ISAA items need clinically reviewed translations; risk 1 |
| D-5 | Time zone | Viewer's own time zone from the browser; fallback `Asia/Kolkata`; storage UTC | product owner 2026-11-12: "based on the user location" |
| D-6 | Voice agents | Unaffected; new agents stay English, Child-Dev intake stays en/hi/te | plan §2 "Voice languages" |

## Open questions

- Who reviews Hindi/Telugu copy before the pilot (human task, plan §6)? Until reviewed, `REVIEW.md`
  rows stay `pending` and are a pilot launch checklist item.
