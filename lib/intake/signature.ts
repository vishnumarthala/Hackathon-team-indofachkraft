import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_SEC = 30 * 60;
// Allowed clock skew for "not in the future", so a webhook signed a moment ahead of our clock still passes.
export const FUTURE_SKEW_SEC = 60;

// Mirrors @elevenlabs/elevenlabs-js webhooks.constructEvent: header `t=<unix s>,v0=<hex>` where
// hex = HMAC-SHA256(secret, "<t>.<rawBody>"). Never throws.
export function verifySignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signature = parts.find((p) => p.startsWith("v0="))?.slice(3);
  if (!timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;

  const t = Number(timestamp);
  const nowSec = nowMs / 1000;
  if (t < nowSec - SIGNATURE_TOLERANCE_SEC || t > nowSec + FUTURE_SKEW_SEC) return false;

  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Test and tooling helper: builds a header the way ElevenLabs does.
export function signPayload(rawBody: string, secret: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const hex = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
  return `t=${timestampSec},v0=${hex}`;
}
