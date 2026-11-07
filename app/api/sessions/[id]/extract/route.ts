import { runExtraction, type ExtractionOutcome } from "@/lib/extraction";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let outcome: ExtractionOutcome;
  try {
    outcome = await runExtraction(id);
  } catch (err) {
    console.error(`extraction could not start for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not start extraction");
  }
  if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.details);
  return ok(outcome.body);
}
