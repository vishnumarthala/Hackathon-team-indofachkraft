import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auditActorOf } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { emailFromIdToken, googleApi, googleConnectAvailable, GoogleError, googleRedirectUri, OAUTH_SCOPES } from "@/lib/google/client";
import { saveGoogleConnection } from "@/lib/google/connections";
import { checkOAuthState, clearedOAuthCookie, OAUTH_COOKIE } from "@/lib/google/oauth";
import { logger } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("google");
const SETTINGS = "/dashboard/settings/integrations";

// 037 FR-2: Google's redirect back. Only for the provider who started the flow, with the state from the sealed cookie
// (anything else: nothing stored, `?error=state`). Exchanges the code (+ PKCE verifier), stores the refresh token
// encrypted (AES-256-GCM) and never sends it to the browser.
export async function GET(req: Request) {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  const url = new URL(req.url);
  const done = (query: string) => {
    const res = NextResponse.redirect(new URL(`${SETTINGS}?${query}`, req.url), 303);
    res.headers.set("Cache-Control", "no-store");
    res.cookies.set(clearedOAuthCookie());
    return res;
  };

  const check = checkOAuthState({
    cookie: (await cookies()).get(OAUTH_COOKIE)?.value,
    state: url.searchParams.get("state"),
    userId: gate.actor.user.id,
  });
  if (!check.ok || check.providerProfileId !== gate.ctx.profile.id) {
    log.warn(`oauth state rejected (${check.ok ? "other_profile" : check.reason}) for user ${gate.actor.user.id}`);
    return done("error=state");
  }
  if (url.searchParams.get("error")) return done("error=denied");
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return done("error=state");
  if (!googleConnectAvailable()) return done("error=unavailable");

  try {
    const tokens = await googleApi().exchangeCode(code, check.codeVerifier, googleRedirectUri());
    const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
    if (!tokens.refresh_token) return done("error=no_refresh_token");
    if (scopes.length > 0 && !scopes.includes(OAUTH_SCOPES[2])) return done("error=scope");
    const email = emailFromIdToken(tokens.id_token);
    if (!email) return done("error=exchange");
    await saveGoogleConnection({
      providerProfileId: gate.ctx.profile.id,
      googleEmail: email,
      refreshToken: tokens.refresh_token,
      scopes: scopes.length ? scopes : [...OAUTH_SCOPES],
      actor: auditActorOf(gate.actor.user, gate.actor.role),
    });
  } catch (err) {
    log.warn(`oauth exchange failed for profile ${gate.ctx.profile.id}: ${err instanceof GoogleError ? err.message : "error"}`);
    return done("error=exchange");
  }
  return done("connected=1");
}
