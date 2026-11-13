// Ticket 045: notification recipients for fee topics (re-checked at fan-out, 032 rule): the child's active guardians,
// and only while the subject still applies (the link is still open, the balance still due, the package still active).
import { activeGuardians } from "@/lib/notify/recipients";
import type { Queryable } from "@/lib/pg";

export async function paymentRequestGuardians(sql: Queryable, paymentId: string, childId: string): Promise<string[]> {
  const [open] = await sql<{ ok: boolean }[]>`
    select exists (select 1 from public.payments where id = ${paymentId} and child_id = ${childId} and status = 'created') as ok`;
  return open?.ok ? activeGuardians(sql, childId) : [];
}

/** The receipt goes to the child's guardians (one-off payments: the child of the appointment). */
export async function receiptGuardians(sql: Queryable, paymentId: string, childId: string): Promise<string[]> {
  const [paid] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from public.payments p left join public.appointments a on a.id = p.appointment_id
      where p.id = ${paymentId} and coalesce(p.child_id, a.child_id) = ${childId} and p.receipt_no is not null
    ) as ok`;
  return paid?.ok ? activeGuardians(sql, childId) : [];
}

export async function balanceReminderGuardians(sql: Queryable, orgId: string, childId: string): Promise<string[]> {
  const [due] = await sql<{ b: string }[]>`select public.fees_balance(${orgId}, ${childId}) as b`;
  return Number(due?.b ?? 0) > 0 ? activeGuardians(sql, childId) : [];
}

export async function packageReminderGuardians(sql: Queryable, childPackageId: string, childId: string): Promise<string[]> {
  const [active] = await sql<{ ok: boolean }[]>`
    select exists (select 1 from public.child_packages where id = ${childPackageId} and child_id = ${childId} and status = 'active') as ok`;
  return active?.ok ? activeGuardians(sql, childId) : [];
}

export async function feeRefundGuardians(sql: Queryable, feeRefundId: string, childId: string): Promise<string[]> {
  const [done] = await sql<{ ok: boolean }[]>`
    select exists (select 1 from public.fee_refunds where id = ${feeRefundId} and child_id = ${childId} and status = 'processed') as ok`;
  return done?.ok ? activeGuardians(sql, childId) : [];
}
