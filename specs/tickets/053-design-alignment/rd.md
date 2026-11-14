# 053: Design-system alignment (teal primary actions, shared UI primitives)

**Status:** done
**Mode:** solo
**Runs:** waits for 043–052: it touches many screens, so it goes last to avoid conflicts

## Summary

The Figma design system ([docs/design-system.md](../../../docs/design-system.md)) uses teal `bg/brand` for
primary actions. About 36 files still use the CareThread-era `bg-slate-900` buttons, and screens mix
several button, badge and input styles. This makes the product feel like separate tools, not one service.

This ticket adds small shared UI primitives that mirror the Figma components, and moves the app onto them
**without changing behaviour**.

## Functional requirements

- **FR-1** – `components/ui/` primitives, named after the Figma components, with variants as in Figma:
  - `Button` (Primary/Secondary/Ghost/Danger × md/sm, with an optional icon, a loading state and
    `asChild`/link support);
  - `Badge` (Neutral/Brand/Success/Warning/Danger/Info);
  - `Alert` (Info/Success/Warning/Danger);
  - `TextField`/`Select` wrappers;
  - `Card`;
  - `EmptyState`.
  
  Tokens map to Tailwind as in design-system.md §3, the minimum touch target is 44 px, and the focus
  ring is `ring-2 ring-teal-600 ring-offset-2`.
- **FR-2** – Replace primary-action `bg-slate-900` buttons and links in `app/**` and `components/**`
  with `Button variant="primary"`. Dark `bg-slate-900` surfaces that aren't buttons stay (for example the
  voice panel, which is `bg/inverse` in Figma).
- **FR-3** – Replace ad-hoc status pills with `Badge` and ad-hoc notices with `Alert` where the meaning is
  the same. Copy doesn't change.
- **FR-4** – The landing pages (`components/landing/**`, their own `--lp-*` palette) are out of scope,
  except where 050 already uses the shared primitives.
- **FR-5** – Add a lint guard: an ESLint `no-restricted-syntax` rule, or a test, that fails on
  `className` strings containing `bg-slate-900` together with `text-white` on `<button>` or `<Link>`
  elements, so the drift doesn't come back. Listed exceptions are allowed.
- **FR-6** – Update `docs/design-system.md` §7 (remove the "primary button colour" gap) and map each
  `components/ui` primitive to its Figma component id.

## Non-functional requirements

- **NFR-1** – No behaviour change: the full test suite passes unchanged, apart from snapshot or class
  assertions updated for the new classes.
- **NFR-2** – Colour contrast AA for all variants (teal-700 on white text passes; check the disabled
  states).

## Affected areas

- `components/ui/**` (new), many `app/**` and `components/**` files (class changes only)
- `eslint.config.mjs` **only if the main checkout has no uncommitted edits to it; otherwise implement FR-5
  as a Vitest test** (the product owner has local edits to `eslint.config.mjs`)
- `docs/design-system.md`

## Out of scope

- Dark mode. Changing layouts. The landing palette.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Library | Own small primitives in `components/ui`, no new dependency | Few components; matches Figma |
| D-2 | Guard | Test-based check (eslint config has local edits) | Prevents regressions without touching the user's file |
