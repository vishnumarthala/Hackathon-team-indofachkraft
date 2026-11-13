import { NextResponse } from "next/server";
import { requireProviderContext } from "@/lib/booking/authz";
import { googleApi, googleConnectAvailable, googleRedirectUri } from "@/lib/google/client";
import { oauthCookie, startOAuth } from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SETTINGS = "/dashboard/settings/integrations";

// 037 FR-2 `Connect Google Calendar`: the signed-in provider (own profile, resolved server-side) is sent to Google's
// consent screen (scope calendar.events + openid email, offline, prompt=consent, PKCE S256). State + verifier are
// sealed in an httpOnly cookie bound to this user (lib/google/oauth.ts).
export async function GET(req: Request) {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  if (!googleConnectAvailable()) return NextResponse.redirect(new URL(`${SETTINGS}?error=unavailable`, req.url), 303);
  const start = startOAuth(gate.actor.user.id, gate.ctx.profile.id);
  const target = googleApi().authorizeUrl({ state: start.state, codeChallenge: start.codeChallenge, redirectUri: googleRedirectUri() });
  const res = NextResponse.redirect(new URL(target, req.url), 303);
  res.headers.set("Cache-Control", "no-store");
  res.cookies.set(oauthCookie(start.cookie));
  return res;
}
