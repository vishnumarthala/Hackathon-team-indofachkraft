# 053: Design-system alignment - Evaluation

## Automated checks

- `npm run verify` exits 0; the full test suite passes.
- `npx vitest run tests/design-guard.test.ts` exits 0. It scans `app/**` and `components/**` for
  primary-button classes `bg-slate-900` + `text-white` on button or link elements: 0 matches outside the
  allowed exceptions.
- `components/ui` unit tests: the variants render the expected classes, `disabled` and `loading` set
  `aria-disabled`/`aria-busy`, and the link variant renders `<a>`.

## Acceptance checks

### E-1: Visual check

Screenshots at 390 px and 1440 px of `/family`, `/dashboard`, `/cases/[id]`, `/find`, `/book/...`,
`/admin/verifications`: primary actions are teal, and focus rings are visible when tabbing.

### E-2: No behaviour change

Click through booking, consent and attendance as in their tickets' evals; the results are the same.
