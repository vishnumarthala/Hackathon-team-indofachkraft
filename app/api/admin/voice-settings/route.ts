import { z } from "zod";
import { auditActorOf, auditFailure } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { ok, parseJson } from "@/lib/http";
import { getVoiceCaps, setVoiceCaps } from "@/lib/voice/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cap = (max: number) => z.number().int("Whole minutes only").min(0).max(max).nullable();
const CapsSchema = z.object({ daily_minutes_cap: cap(10_000_000), monthly_minutes_cap: cap(100_000_000) }).strict();

// 051 FR-10: platform admins read and change the voice budget at runtime (null = back to the env value). The change
// and its `voice.caps_updated` audit row commit together (fail closed). Other roles: 403.
export async function GET() {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  return ok(await getVoiceCaps());
}

export async function PUT(req: Request) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, CapsSchema);
  if ("response" in parsed) return parsed.response;
  try {
    await setVoiceCaps(auditActorOf(gate.actor.user, gate.actor.role), {
      dailyMinutesCap: parsed.data.daily_minutes_cap,
      monthlyMinutesCap: parsed.data.monthly_minutes_cap,
    });
  } catch (err) {
    return auditFailure(err);
  }
  return ok(await getVoiceCaps());
}
