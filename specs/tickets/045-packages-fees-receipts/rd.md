# 045: Packages, family fee ledger and receipts

**Status:** ready
**Mode:** solo
**Runs:** waits for 043, 044: packages cover series sessions; attendance consumes them

## Summary

Families pay the **centre**: usually a monthly package (for example 12 sessions for ₹9,000), sometimes per
session, in cash, UPI or card at the desk, or online. This ticket gives centres packages, a per-child fee
ledger with balance due, payment recording (offline or a Razorpay payment link), and numbered receipts
the family receives in the portal and on WhatsApp. It also produces the **per-consultation amounts** that
046 uses for the platform fee.

Source: product owner decision 2026-11-13: "parent pays to the center/therapist, and center/therapist pays
to us for each consultation fee as part of main fee."

## Functional requirements

- **FR-1** – Migration `<ts>_packages_ledger.sql`:
  - `packages(id, org_id, name, session_count int 1–60, price_inr int, validity_days int 7–180,
    service_ids uuid[], active)`.
  - `child_packages(id, org_id, child_id, package_id, snapshot jsonb, starts_on, expires_on,
    sessions_total, sessions_used, status check in ('active','used_up','expired','cancelled'))`.
  - `family_ledger(id, org_id, child_id, kind check in ('charge','payment','refund','adjustment'),
    amount_paise int, method check in ('cash','upi','card','bank','razorpay') null, appointment_id null,
    child_package_id null, note, receipt_no null, created_by, created_at)`, append-only.
  - `org_receipt_counters(org_id, fy text, next int)`.
  - Register all of them in the 041 privacy registry.
- **FR-2** – Charges:
  - **Package:** selling a package creates one `charge` for the price.
  - **Per-session billing** (`billing_mode = per_session_at_clinic` or `per_session_online`): a `charge`
    is created when attendance marks the session billable (044).
  - **Package sessions:** a billable session uses up one package session (`sessions_used + 1`). Status
    becomes `used_up` at the total. It is `expired` after `expires_on`; leftover sessions don't carry over
    unless staff adds an `adjustment`.
- **FR-3** – Each billable session has a **consultation amount**: the per-session fee, or package price ÷
  `sessions_total`, rounded down to the paisa, with the remainder on the last session. It is stored on the
  appointment as `consultation_amount_paise` and is the base for the 046 platform fee.
- **FR-4** – Payments:
  - **Offline:** staff use `Record payment` (amount, method, date, note), which creates a `payment` entry
    with a receipt number `<ORGCODE>/<FY>/<0001>`. Indian financial year, gap-free per org, allocated in
    the same transaction.
  - **Online:** `Send payment link` creates a Razorpay **payment link** (test mode, D-1 of 031) for the
    balance or a package. The webhook records the `payment` via the existing signed, deduped handler.
    Route split is added in 046.
- **FR-5** – Receipts: a PDF receipt (org name, address, optional GSTIN, child first name, items, amount,
  method, receipt number, "Paid to <centre>"). Staff can download it. Guardians see it in a new
  `/family/children/[id]/payments` page; with a guardian account it is also sent through the outbox
  (in-app + WhatsApp template `receipt_ready`).
- **FR-6** – Staff UI:
  - Case page tab `Fees` shows balance due, the active package with sessions left, the ledger, and the
    `Sell package`, `Record payment`, `Send payment link` and `Adjustment` buttons (owner/admin only).
  - Org settings get a `Packages` editor.
  - `/dashboard/fees` lists balances due across children.
- **FR-7** – Warnings: when a package has ≤ 2 sessions left or expires within 7 days, staff see a badge.
  With a guardian account, the guardian gets one reminder.
- **FR-8** – Corrections are never edits or deletes: wrong entries are reversed with an `adjustment`, a
  reason, and an audit event.

## Non-functional requirements

- **NFR-1** – Money is integer paise everywhere; display with `formatInr`.
- **NFR-2** – Receipt numbers are unique and gap-free per org and FY under concurrency (test with 20
  parallel payments).
- **NFR-3** – No card/UPI details stored (as 031).

## Affected areas

- `supabase/migrations/<ts>_packages_ledger.sql` (new)
- `lib/fees/**` (new), `lib/payments/razorpay.ts` (payment links), `app/api/webhooks/razorpay` (link events)
- `app/cases/[id]/**` (Fees tab), `app/dashboard/fees/**`, org settings (Packages)
- `app/family/children/[id]/payments/**` (new)
- `lib/notify/topics.ts`, `lib/privacy/registry.ts`, `messages/{en,hi,te}.json`
- `tests/fees-*.test.ts` (new)

## Don't touch

- 031 one-off checkout flow (keep working); existing migrations; `BOARD.md`.

## Out of scope

- GST calculation on the centre's own fees (healthcare services may be exempt; the centre's accountant
  decides). There is only a free-text GSTIN on receipts.
- Insurance, sibling discounts, coupons, instalments.

## Decisions

| # | Question | Decision | Why |
|---|----------|----------|-----|
| D-1 | Who receives the family's money | The centre (offline) or the centre via Razorpay (online, split in 046) | Product owner decision 2026-11-13 |
| D-2 | Ledger | Append-only, corrections by adjustment | Money records must not change silently |
| D-3 | Per-session value of a package | Price ÷ sessions, remainder on the last | Needed for the per-consultation platform fee |

## Open questions

- Refund policy for unused package sessions (each centre decides; default no automatic refund).
