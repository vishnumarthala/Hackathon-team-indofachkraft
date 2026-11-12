import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getUserRole } from "@/lib/auth";
import { FAMILY_LOGIN_PATH, postSignInPath } from "@/lib/auth-access";
import { supabaseRouteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const SETTINGS_PATH = "/family/settings";

function redirectTo(req: Request, path: string) {
  // `path` is always a same-origin relative path (fixed strings or postSignInPath()).
  return NextResponse.redirect(new URL(path, req.url));
}

// 019 FR-3/FR-9: OAuth return (Google sign-in from /family/login and `linkIdentity` from settings).
// `flow=link` marks a Connect Google round trip. Supabase reports a Google account that already belongs to
// another user as `identity_already_exists`; nothing is merged and the guardian sees the FR-9 message.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const isLink = url.searchParams.get("flow") === "link";
  const errorCode = url.searchParams.get("error_code") ?? url.searchParams.get("error");
  if (errorCode) {
    if (!isLink) return redirectTo(req, `${FAMILY_LOGIN_PATH}?error=oauth`);
    const reason = errorCode === "identity_already_exists" ? "google_in_use" : "link_failed";
    return redirectTo(req, `${SETTINGS_PATH}?error=${reason}`);
  }

  const code = url.searchParams.get("code");
  if (!code) return redirectTo(req, isLink ? `${SETTINGS_PATH}?error=link_failed` : `${FAMILY_LOGIN_PATH}?error=oauth`);

  const supabase = await supabaseRouteClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    console.error(`[auth/callback] code exchange failed: ${error?.code ?? "no user"}`);
    return redirectTo(req, isLink ? `${SETTINGS_PATH}?error=link_failed` : `${FAMILY_LOGIN_PATH}?error=oauth`);
  }

  const role = await getUserRole(data.user.id);
  if (isLink && role === "guardian") {
    if (!data.user.identities?.some((identity) => identity.provider === "google")) {
      return redirectTo(req, `${SETTINGS_PATH}?error=link_failed`);
    }
    await audit({
      actor: "parent",
      actorUserId: data.user.id,
      action: "guardian.identity_linked",
      entity: "user",
      entityId: data.user.id,
      details: { provider: "google" },
    });
    return redirectTo(req, `${SETTINGS_PATH}?linked=google`);
  }
  return redirectTo(req, postSignInPath(role, url.searchParams.get("next")));
}
