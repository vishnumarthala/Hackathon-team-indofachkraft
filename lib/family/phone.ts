// Indian mobile numbers for guardian sign-in (ticket 019). Safe in client and server code.
// Canonical form is E.164 digits without '+', e.g. "919000000003" (what Supabase stores in auth.users.phone).

export const MOBILE_ERROR = "Enter a 10-digit Indian mobile number";
export const OTP_CODE_ERROR = "Enter the 6-digit code";
export const WRONG_CODE_ERROR = "That code is not correct or has expired.";
export const PHONE_IN_USE_ERROR = "This number is already linked to another account.";

/** 10 digits, first digit 6-9. Accepts spaces/hyphens and an optional +91 / 91 / 0 prefix. */
export function normalizeIndianMobile(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const compact = input.replace(/[\s-]/g, "");
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  return match ? `91${match[1]}` : null;
}

export function isOtpCode(input: unknown): input is string {
  return typeof input === "string" && /^\d{6}$/.test(input);
}

export function phoneLast4(phone: string): string {
  return phone.replace(/\D/g, "").slice(-4);
}

/** `+91 ••••••1234` (FR-8). */
export function maskPhone(phone: string): string {
  return `+91 ••••••${phoneLast4(phone)}`;
}

/** NFR-4: strip anything that looks like a phone number from text that may be logged. */
export function redactPhones(text: string): string {
  return text.replace(/\+?\d[\d\s-]{7,}\d/g, "[redacted]");
}
