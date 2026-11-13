import { NextResponse } from "next/server";
import { requireProviderContext } from "@/lib/booking/authz";
import { demoIssueCode, googleBackend } from "@/lib/google/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 037 demo backend only (DEMO_MODE without a Google OAuth client): stands in for Google's consent screen and sends
// the browser straight back to the callback with a one-time code bound to the PKCE challenge. 404 otherwise.
export async function GET(req: Request) {
  if (googleBackend() !== "demo") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  if (!state || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length > 200) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const back = new URL("/api/integrations/google/callback", req.url);
  back.searchParams.set("code", demoIssueCode(challenge));
  back.searchParams.set("state", state);
  return NextResponse.redirect(back, 303);
}
