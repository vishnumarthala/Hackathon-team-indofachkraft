import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/privacy/ops";
import pkg from "@/package.json";

// 041 FR-12: public liveness check. No secrets, no counts: `{ ok, db, version }`; 503 when the database is unreachable.
export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await checkDatabase();
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? pkg.version;
  return NextResponse.json(
    { ok: dbOk, db: dbOk ? "ok" : "unreachable", version },
    { status: dbOk ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
