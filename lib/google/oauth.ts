// 037 FR-2: Google OAuth for providers (authorization code + PKCE S256, `access_type=offline`, `prompt=consent`).
// The `state` is bound to the signed-in session: it travels in an httpOnly cookie sealed with AES-256-GCM together
// with the PKCE verifier, the user id and the provider profile id, and expires after 10 minutes. The callback accepts
// the code only when the query `state` equals the sealed one AND the session user is the one who started the flow.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { codeChallengeOf, newCodeVerifier } from "./client";
import { openJson, sealJson } from "./crypto";

export const OAUTH_COOKIE = "dnm_google_oauth";
export const OAUTH_COOKIE_PATH = "/api/integrations/google";
const STATE_AAD = "google-oauth-state:v1";
const TTL_MS = 10 * 60_000;

type Sealed = { s: string; v: string; u: string; p: string; e: number };

export type OAuthStart = { state: string; codeChallenge: string; cookie: string };

export function startOAuth(userId: string, providerProfileId: string, now = Date.now()): OAuthStart {
  const state = randomBytes(32).toString("base64url");
  const verifier = newCodeVerifier();
  const cookie = sealJson({ s: state, v: verifier, u: userId, p: providerProfileId, e: now + TTL_MS } satisfies Sealed, STATE_AAD);
  return { state, codeChallenge: codeChallengeOf(verifier), cookie };
}

export type OAuthCheck =
  | { ok: true; codeVerifier: string; providerProfileId: string }
  | { ok: false; reason: "missing" | "expired" | "mismatch" | "other_user" };

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Validates the callback's `state` against the sealed cookie and the current session user. */
export function checkOAuthState(input: { cookie: string | undefined; state: string | null; userId: string; now?: number }): OAuthCheck {
  const sealed = openJson<Sealed>(input.cookie, STATE_AAD);
  if (!sealed || typeof sealed.s !== "string" || typeof sealed.v !== "string") return { ok: false, reason: "missing" };
  if (!input.state || !sameString(sealed.s, input.state)) return { ok: false, reason: "mismatch" };
  if (sealed.e < (input.now ?? Date.now())) return { ok: false, reason: "expired" };
  if (sealed.u !== input.userId) return { ok: false, reason: "other_user" };
  return { ok: true, codeVerifier: sealed.v, providerProfileId: sealed.p };
}

export function oauthCookie(value: string) {
  return {
    name: OAUTH_COOKIE,
    value,
    httpOnly: true,
    // lax: Google's redirect back is a top-level GET navigation, which carries lax cookies.
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: OAUTH_COOKIE_PATH,
    maxAge: TTL_MS / 1000,
  };
}

export function clearedOAuthCookie() {
  return { ...oauthCookie(""), maxAge: 0 };
}
