import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { fail, ok, parseJson } from "@/lib/http";
import { swapSpeakers, type SwapResult } from "@/lib/speakers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const swapSchema = z.object({ swap: z.literal(true, { error: "swap must be true" }) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const parsed = await parseJson(req, swapSchema);
  if ("response" in parsed) return parsed.response;

  let result: SwapResult;
  try {
    result = await swapSpeakers(id);
  } catch (err) {
    console.error(`speaker swap failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not swap the speakers");
  }
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data);
}
