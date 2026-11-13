// Ticket 035: appointment intake link tokens. Server only (node:crypto).
// The token is an HMAC of the attempt id (43 base64url characters). Only its SHA-256 is stored
// (`intake_attempts.token_hash`), yet the server can re-derive the link for the guardian (confirmation email, the
// family appointments page) without keeping the token anywhere. Rotating INTAKE_LINK_SECRET invalidates open links.
import { createHash, createHmac } from "node:crypto";
import { env } from "@/lib/env";

const TOKEN_CONTEXT = "doctornearme:intake-attempt:v1:";
export const ATTEMPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function linkSecret(): string {
  const secret = env.INTAKE_LINK_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("Missing env var: INTAKE_LINK_SECRET");
  return secret;
}

export function intakeAttemptToken(attemptId: string, secret: string = linkSecret()): string {
  return createHmac("sha256", secret).update(`${TOKEN_CONTEXT}${attemptId}`).digest("base64url");
}

export function hashIntakeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function intakeAttemptPath(attemptId: string): string {
  return `/intake/a/${intakeAttemptToken(attemptId)}`;
}

export function intakeAttemptUrl(appUrl: string, attemptId: string): string {
  return `${appUrl.replace(/\/+$/, "")}${intakeAttemptPath(attemptId)}`;
}
