# 027: Secure messaging - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes) before coding.
- `cp <main checkout>/.env.local .env.local`, `npm install`, `npm run db:migrate`. Local Supabase
  Realtime must be running (default in `supabase start`).
- Accounts: `npm run -s seed:users -- --prefix <acct> --extra-member`; child of `guardian_a` with an org A
  case (`provider_a` assigned, `provider_a2` not assigned) and an org B case.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`; outbox via `npm run -s outbox:run`. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/messaging-rls.test.ts tests/messaging-api.test.ts --reporter=verbose` exits 0:
  - RLS with real user JWTs: guardian_a / provider_a can select the thread; provider_a2 (unassigned),
    provider_b (other org), guardian_b, anon cannot; nobody can insert via the anon client;
  - after revoking `guardian_a`'s link / removing `provider_a`'s assignment / revoking org membership:
    select returns 0 rows and a Realtime subscription receives no further inserts;
  - idempotent `client_id`, rate limit 429, archived 409, delete window 15 min;
  - message insert and outbox event are atomic (forced failure of enqueue rolls back the message).

## Acceptance checks

### E-1: Conversation with live delivery (FR-2, FR-4, FR-5)

1. Two browsers: `guardian_a` on `/family/messages`, `provider_a` on the case `Messages` tab.
2. Guardian starts thread `<acct> Sleep question` with a synthetic message. Provider sees it within
   3 s without reload (screen recording or timestamps in `evidence/`). Provider replies; guardian sees it live.
3. Banner with 108/112 is visible on both.

### E-2: Notification behaviour (FR-3)

1. Provider sends a message while the guardian has the thread closed; after 2 minutes + cron the
   guardian gets an in-app notification `You have a new message on DoctorNearMe.`; email body contains
   no message text.
2. Send another while the guardian has the thread open (read marker updated): no notification.

### E-3: Revocation (NFR-2)

With the guardian's thread page open, revoke `provider_a`'s assignment and send from `guardian_a`:
the provider's page shows `You no longer have access to this conversation.` (or receives nothing and
gets 404 on refresh). `provider_a2`/`provider_b` direct API calls -> 404.

### E-4: Attachment and idempotency (FR-2)

Attach a document visible to both -> link works; attach a provider-only document (`visible_to_guardian =
false`) -> 422. Re-send the same `client_id` -> one message.

### E-5: Privacy (NFR-3)

Audit rows for `message.sent` contain ids only; server log grep for the synthetic message text -> no hits.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] A builder reviews results and manually merges the passing ticket branch.
