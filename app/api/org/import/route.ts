import { auditActorOf, AuditWriteError, auditFailure } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { fail, ok } from "@/lib/http";
import { checkImportManager, previewJson, readUpload, runImport } from "@/lib/import/store";
import { issue } from "@/lib/import/validate";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const NOTHING_TO_IMPORT = "There are no rows to import. Fix the rows with errors in your spreadsheet and upload it again.";

// 047 FR-3: import the valid rows of a CSV (plus the duplicates chosen with `Import anyway`). The server validates
// the file again; one transaction per file; a repeated upload of the same file returns the first import.
export async function POST(req: Request) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const upload = await readUpload(req);
  if ("response" in upload) return upload.response;
  const denied = await checkImportManager(gate.actor.user.id, upload.orgId);
  if (denied) return denied;

  const actor = { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id };
  let outcome: Awaited<ReturnType<typeof runImport>>;
  try {
    outcome = await runImport({ orgId: upload.orgId as string, actor, bytes: upload.bytes, importDuplicates: upload.importDuplicates });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    console.error(`child import failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not import. Nothing was saved. Please try again.");
  }

  let res: Response;
  if (outcome.result === "invalid") {
    const first = outcome.prepared.fileErrors[0] ?? issue("empty");
    res = fail(422, first.message, { preview: previewJson(outcome.prepared) });
  } else if (outcome.result === "nothing_to_import") {
    res = fail(422, NOTHING_TO_IMPORT, { preview: previewJson(outcome.prepared) });
  } else if (outcome.result === "existing") {
    res = ok({ result: "existing", import: outcome.import });
  } else {
    const rows = outcome.prepared.rows;
    const created = new Set(outcome.items.map((i) => i.row));
    res = ok(
      {
        result: "imported",
        import: outcome.import,
        items: outcome.items,
        failed: rows.filter((r) => r.status === "error").map((r) => ({ row: r.row, errors: r.errors })),
        skipped: rows.filter((r) => r.status === "duplicate" && !created.has(r.row)).map((r) => r.row),
      },
      201,
    );
  }
  res.headers.set("Cache-Control", "no-store");
  return res;
}
