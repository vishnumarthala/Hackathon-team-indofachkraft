// 036 FR-4 comment screening (D-3: no names, contact details or child names in public comments). Pure.
//   * phone numbers, email addresses / handles, links, and the booked child's (or a sibling's) name -> rejected
//     (422 `Please remove names and contact details from your comment`);
//   * a small profanity / abuse list -> accepted but held for admin review (`pending_review`).
// The lists are a first pass for the pilot (English plus common Hindi/Telugu words in Latin and native script) and
// need native review with messages/REVIEW.md; moderation (FR-6) catches the rest.
import { COMMENT_MAX } from "./rules";

export const SCREEN_REJECTED = "Please remove names and contact details from your comment";

export type ScreenReason = "phone" | "email" | "url" | "name";
export type ScreenResult =
  | { ok: true; comment: string | null; needsReview: boolean }
  | { ok: false; reason: ScreenReason };

// 7+ digits in a row, allowing spaces, dashes, dots, brackets and a leading +, in any script's digits.
const PHONE = /\+?\p{Nd}(?:[\s\-.()]{0,3}\p{Nd}){6,}/u;
const EMAIL = /[\p{L}\p{N}._%+-]+\s*(?:@|\(at\)|\[at\]|\{at\})\s*[\p{L}\p{N}-]+(?:\s*(?:\.|\(dot\)|\[dot\])\s*[\p{L}\p{N}-]+)+/iu;
// Social handles (`@name`) are contact details too.
const HANDLE = /(?:^|[^\p{L}\p{N}])@[\p{L}\p{N}_.]{2,}/u;
const URL =
  /(?:https?:\/\/|www\.)|\b[\p{L}\p{N}-]+\.(?:com|in|org|net|co|io|me|info|biz|app|link|ly|site|online|health|clinic|care|xyz|page|wa)\b/iu;

// Name tokens that are ordinary words (never treated as a name on their own).
const NAME_STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "baby", "boy", "girl", "child", "kid", "son", "daughter", "little", "junior", "jr",
  "sr", "mr", "mrs", "ms", "dr", "master", "miss", "test", "demo", "synthetic", "deleted", "sample",
]);

const ABUSE_WORDS = new Set([
  // English
  "asshole", "bastard", "bitch", "bullshit", "crap", "dick", "idiot", "idiots", "moron", "stupid", "scam", "scammer",
  "fraud", "frauds", "cheat", "cheater", "cheating", "liar", "quack", "shit", "shitty", "slut", "whore", "wtf",
  // Hindi (Latin script)
  "chutiya", "chutiye", "madarchod", "behenchod", "bhenchod", "harami", "kamina", "kamine", "gandu",
  "saala", "saale", "kutta", "kutte",
  // Telugu (Latin script)
  "lanja", "dengu", "puka", "nakodaka", "erripuka", "donga",
  // Hindi / Telugu (native script)
  "चूतिया", "हरामी", "कमीना", "कुत्ता", "गांडू", "मादरचोद", "లంజ", "దొంగ", "ఎర్రిపుక",
]);
const ABUSE_PREFIXES = ["fuck", "motherf", "shit", "bitch"];

/** NFKC, lower case, single spaces. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Letter/number runs, keeping combining marks (Devanagari and Telugu vowel signs). */
export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
}

function nameTokens(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const token of tokens(name)) {
      if (token.length >= 2 && !NAME_STOPWORDS.has(token) && !/^\p{N}+$/u.test(token)) out.add(token);
    }
  }
  return [...out];
}

/** Does the comment contain one of the names (any part of it, as a whole word)? */
export function mentionsName(comment: string, names: string[]): boolean {
  const words = new Set(tokens(comment));
  if (nameTokens(names).some((t) => words.has(t))) return true;
  const flat = normalize(comment);
  return names.map(normalize).some((n) => n.length >= 3 && flat.includes(n));
}

export function contactReason(comment: string): ScreenReason | null {
  if (PHONE.test(comment)) return "phone";
  if (EMAIL.test(comment) || HANDLE.test(comment)) return "email";
  if (URL.test(comment)) return "url";
  return null;
}

export function isAbusive(comment: string): boolean {
  return tokens(comment).some((t) => ABUSE_WORDS.has(t) || ABUSE_PREFIXES.some((p) => t.startsWith(p)));
}

/**
 * Screen a guardian's comment. `names`: display names of the booked child (and the guardian's other children);
 * never stored or logged here. Empty / whitespace-only comments become null.
 */
export function screenComment(raw: string | null | undefined, names: string[]): ScreenResult {
  const comment = (raw ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!comment) return { ok: true, comment: null, needsReview: false };
  if (comment.length > COMMENT_MAX) throw new Error("comment too long (validate the length first)");
  const contact = contactReason(comment);
  if (contact) return { ok: false, reason: contact };
  if (mentionsName(comment, names)) return { ok: false, reason: "name" };
  return { ok: true, comment, needsReview: isAbusive(comment) };
}
