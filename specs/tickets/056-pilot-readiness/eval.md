# 056: Pilot readiness - Evaluation

## Automated checks

- `npm run typecheck` and `npm run lint` exit 0.
- `npx vitest run tests/pilot-readiness.test.ts` covers:
  - a free pilot with Google-only sign-in is **Ready**;
  - each blocker turns it **Blocked**;
  - no sign-in method at all is blocked;
  - payments on with Razorpay keys is consistent, and is then no longer "deferred";
  - checklist links, including the import fallback without cases;
  - phone availability follows `external.phone` (and `DEMO_MODE`);
  - the login renders Google only with the note when phone is off, and the phone form when it is on;
  - (database) the setup facts turn true from real data and are scoped to the owner's organisation.
- The i18n parity tests (`tests/i18n-keys.test.ts`) pass with the new en/hi/te keys, and `messages/REVIEW.md` has been
  regenerated.

## Acceptance checks

### E-1: Pilot deployment

On `/admin/ops` the readiness card says **Blocked** with `DEMO_MODE=true`. With the runbook §2 settings it says
**Ready**, with warnings only for WhatsApp, DLT phone sign-in and the other recommended items.

### E-2: A new centre

A new owner sees "Set up your centre 0 of 6". After inviting a therapist, importing children and sharing a clinic
code that the parent claims, it shows 3 of 6. After the first session note and a published home program, the card
is gone.

### E-3: Google-only families

With no SMS provider, `/family/login` shows only "Continue with Google" and the note. Once the provider is enabled in
Supabase, the phone form appears within 5 minutes (cache), without a deploy.
