# 050: Parent-first home page and Indian statistics

**Status:** draft (proposed by the [PMF check](../../grill/doctornearme-pmf-check.md); needs product owner OK)
**Mode:** solo
**Runs:** alongside

## Summary

The home page `/` speaks only to therapists ("For early intervention therapists", "Book a demo"). It also
quotes US and German statistics (CDC, Höfer 2019). Parents, who make up most of the traffic from search
and paediatrician referrals, only find `/find` and `/screen` in the nav.

This ticket:
- makes `/` a parent-first page;
- moves the current page to `/for-centres`;
- swaps in Indian statistics with sources.

## Functional requirements

- **FR-1** – Move the current landing to `/for-centres` (same components, same `Book a demo`). Add the nav
  item `For centres`. `/book-demo` is unchanged.
- **FR-2** – The new `/` for parents (390 px first, en/hi/te):
  - Hero: "Worried about your child's speech, play or development?"
  - Two main actions: `Start a free check-in` (`/screen`) and `Find a therapist near you` (`/find`).
  - A "How it works" strip: Check-in → Find → Visit → Practise at home.
  - Trust row: verified providers, no ads or tracking on child pages, your data stays yours.
  - "Already with a centre? Enter your clinic code" → `/family/children/claim`.
- **FR-3** – Indian statistics with sources on both pages, replacing the US/German ones:
  - About 1 in 100 children under 10 may have autism, and about 1 in 8 has at least one
    neurodevelopmental condition (INCLEN 2018).
  - Average age at autism diagnosis is about 4.6 years in an Indian clinic sample.
  - About 15,000 registered speech and hearing professionals for 1.4 billion people (RCI 2023-24).
  
  Use the URLs from the PMF check sources; keep "Sources:" under the block.
- **FR-4** – Metadata: `/` title "DoctorNearMe – child development check-in and therapists near you
  (Hyderabad)"; `/for-centres` keeps the current title. Add `hreflang` alternates for en/hi/te if 018
  supports them.
- **FR-5** – No new third-party scripts. The no-tracking rule applies (child-related page).

## Affected areas

- `app/page.tsx`, `app/for-centres/page.tsx` (new), `components/landing/**`, `messages/{en,hi,te}.json`
- `docs/design-system.md` (screen index row), Figma "Screens · Public & parents" (designer task)

## Out of scope

- Locality SEO pages ("speech therapy in Kukatpally") – separate ticket.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Who owns `/` | Parents; centres get `/for-centres` | Parents are the volume; centres arrive through sales and demos |
| D-2 | Statistics | Indian sources only on Indian pages | Credibility for the Hyderabad pilot |

## Open questions

- Keep a short "For centres" teaser block on `/`? (Default: one line plus a link in the footer and nav.)
