import { isDemoMode } from "@/lib/demo";
import { fail, ok } from "@/lib/http";
import { demoPostCallData, processPostCall } from "@/lib/intake/process";
import { getCaseByToken } from "@/lib/queries/intake";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!isDemoMode()) return fail(404, "Not found");
  const { token } = await params;
  const caseRow = await getCaseByToken(token);
  if (!caseRow) return fail(404, "This link is not valid.");

  try {
    return ok(await processPostCall(demoPostCallData(token, `demo-${Date.now()}`)));
  } catch (err) {
    console.error(`simulate intake: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not save the call");
  }
}
