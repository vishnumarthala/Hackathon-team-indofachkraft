# 032: Notifications outbox - Evaluation

## Setup

- Read `node_modules/next/dist/docs/` (Next.js 16.4 breaking changes: route handlers, caching
  defaults - cron routes must be dynamic) before coding.
- `cp <main checkout>/.env.local .env.local`, add `CRON_SECRET=test-<port>`, `npm install`, `npm run db:migrate`.
- Accounts: `npm run -s seed:users -- --prefix <acct>`.
- Start: `DEMO_MODE=true npm run dev -- -p <port>`. WhatsApp and Resend are mocked in tests; no real
  messages are sent. Synthetic data only.

## Automated checks

- `npm run verify` exits 0.
- `npx vitest run tests/outbox.test.ts tests/notify-adapters.test.ts tests/notify-templates.test.ts --reporter=verbose` exits 0, covering:
  - enqueue in a transaction that rolls back -> no event; same `dedup_key` twice -> one event;
  - two concurrent `notifications_claim` calls (two DB connections) never return the same row;
    expired lease is reclaimed;
  - retry schedule (1m, 5m, 30m, 2h, 12h) then `dead`; permanent error -> `dead` at once;
  - fan-out re-checks access: a guardian whose link was revoked between enqueue and fan-out gets no row;
  - WhatsApp adapter: request URL/body for a template, `skipped` without env, `opted_out` with preference off;
  - email adapter: `.ics` attachment with stable UID and incremented SEQUENCE; `Idempotency-Key` header;
  - templates: every template renders in en/hi/te; email/WhatsApp outputs contain no `display_name` of
    the child and no clinical terms from a deny list (`autism`, `ISAA`, `diagnos`, `score`).

## Acceptance checks

### E-1: End-to-end in-app + email (FR-1, FR-4, FR-6, FR-7)

1. `npm run -s db:sql -- "select outbox_enqueue('test.ping','user','<guardian_a id>','{}'::jsonb,'ping-<acct>',now())"`.
2. `curl -X POST -H "Authorization: Bearer test-<port>" http://localhost:<port>/api/cron/outbox` -> 200 with
   `fanned_out >= 1`. Without the header -> 401.
3. As `guardian_a`, bell shows `1 unread`; `/notifications` lists it; `Mark all as read` clears the count.
4. Email notification row `sent` (demo) with `provider_message_id` or demo marker.

### E-2: Scheduled + cancel (FR-1)

Enqueue with `deliver_after = now() + interval '2 minutes'`: cron run now -> not fanned out; after 2
minutes -> fanned out. Enqueue another and call `outbox_cancel('ping-cancel-')` -> `cancelled`, never sent.

### E-3: WhatsApp skipped, preferences (FR-6, FR-8)

Without WhatsApp env: whatsapp rows `skipped` / `whatsapp_not_configured`, domain flow unaffected.
Turn `Email` off for `guardian_a`: next event -> email row `skipped` / `opted_out`; in-app still delivered.

### E-4: Authz negatives (FR-7, FR-9)

`guardian_b` `GET /api/notifications` never returns `guardian_a`'s rows; `POST /api/notifications/read`
with `guardian_a`'s ids changes nothing. `/admin/notifications` as a provider -> 403/redirect.

### E-5: Concurrency (NFR-2)

Run two `outbox:run` processes for 1 minute against 200 queued notifications (mocked senders count
calls): each notification sent exactly once.

## Definition of done

- [ ] All checks pass with evidence in `results.md`.
- [ ] `docs/notifications.md` lists the WhatsApp templates to submit (human task).
- [ ] A builder reviews results and manually merges the passing ticket branch.
