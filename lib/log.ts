// 041 NFR-2: no personal data in server logs. `redact()` masks email addresses, phone numbers (keeps the last 4
// digits), bearer/JWT/opaque tokens and signed-URL tokens; `log` is a thin console wrapper that redacts the
// message and any metadata. Ids (uuids) and counts stay readable for operations. Use it for every new log line
// that could carry user input or provider errors.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /\b(Bearer|Basic)\s+[^\s"',;]+/gi;
const QUERY_SECRET = /([?&](?:token|code|key|apikey|api_key|signature|sig|access_token|refresh_token)=)[^&\s"']+/gi;
const OPAQUE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// +CC numbers with optional spaces/dashes, bare 10-13 digit runs, and Indian `NNNNN NNNNN`. Dates and times do
// not match (too few digits per run).
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s-]?\d{3,5}[\s-]?\d{3,5}(?:[\s-]?\d{1,5})?|\d{10,13}|\d{5}[\s-]\d{5})(?!\w)/g;

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return match;
  return `***${digits.slice(-4)}`;
}

export function redact(text: string): string {
  return text
    .replace(JWT, "[token]")
    .replace(BEARER, "$1 [token]")
    .replace(QUERY_SECRET, "$1[token]")
    .replace(EMAIL, "[email]")
    .replace(OPAQUE, (m) => (UUID.test(m) ? m : "[token]"))
    .replace(PHONE, maskPhone);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(value.message);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, depth + 1)]));
}

function format(scope: string, message: string, meta?: Record<string, unknown>): string {
  const base = `[${scope}] ${redact(message)}`;
  return meta && Object.keys(meta).length > 0 ? `${base} ${JSON.stringify(redactValue(meta))}` : base;
}

export function errorMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function logger(scope: string) {
  return {
    info: (message: string, meta?: Record<string, unknown>) => console.info(format(scope, message, meta)),
    warn: (message: string, meta?: Record<string, unknown>) => console.warn(format(scope, message, meta)),
    error: (message: string, meta?: Record<string, unknown>) => console.error(format(scope, message, meta)),
  };
}
