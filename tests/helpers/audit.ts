// 041: audit_events is append-only (the trigger raises on delete for every role). Test suites that remove their own
// synthetic audit rows do it through the documented maintenance flag, in one transaction (local test databases only).
import type { Sql, TransactionSql } from "postgres";

export async function purgeTestAudit(sql: Sql, remove: (tx: TransactionSql) => Promise<unknown>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select set_config('dnm.audit_maintenance', 'on', true)`;
    await remove(tx);
  });
}
