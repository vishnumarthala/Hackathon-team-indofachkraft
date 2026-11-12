// Helpers for messages/REVIEW.md (ticket 018, FR-11), shared by scripts/i18n-review.ts and the key tests.

export type ReviewRow = { key: string; en: string; hi: string; te: string; reviewer: string; status: string };

export const REVIEW_STATUSES = ["pending", "approved", "changes-requested"] as const;

export const REVIEW_HEADER = "| key | en | hi | te | reviewer | status |\n| --- | --- | --- | --- | --- | --- |";

type Tree = { [key: string]: string | Tree };

/** `{ a: { b: "x" } }` -> `{ "a.b": "x" }`. */
export function flattenMessages(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else Object.assign(out, flattenMessages(value, path));
  }
  return out;
}

const escapeCell = (value: string) => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
const unescapeCell = (value: string) => value.replace(/\\\|/g, "|").replace(/\\\\/g, "\\");

export function reviewRow(row: ReviewRow): string {
  return `| \`${row.key}\` | ${[row.en, row.hi, row.te, row.reviewer, row.status].map(escapeCell).join(" | ")} |`;
}

/** Parses the table rows of REVIEW.md (rows start with "| `key`"). */
export function parseReviewTable(markdown: string): ReviewRow[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => unescapeCell(cell.trim()));
      const [key, en, hi, te, reviewer, status] = cells;
      return { key: key.replace(/`/g, ""), en, hi, te, reviewer, status };
    });
}
