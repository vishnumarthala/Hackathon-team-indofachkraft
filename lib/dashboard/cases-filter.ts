// Ticket 052 FR-4: the dashboard case list's filter chips (All / Needs review / Booked / Referred) and search. Pure.
import type { CaseRow } from "@/lib/types";

export const CASE_FILTERS = ["all", "review", "booked", "referred"] as const;
export type CaseFilter = (typeof CASE_FILTERS)[number];

export function parseCaseFilter(value: string | undefined): CaseFilter {
  return (CASE_FILTERS as readonly string[]).includes(value ?? "") ? (value as CaseFilter) : "all";
}

/** Pure: the filter chip and the search (child or parent alias, case-insensitive). */
export function filterCases<T extends Pick<CaseRow, "status" | "child_alias" | "parent_alias">>(rows: T[], filter: CaseFilter, q: string): T[] {
  const needle = q.trim().toLocaleLowerCase();
  return rows.filter((c) => {
    if (filter === "review" && c.status !== "intake_done" && c.status !== "in_assessment") return false;
    if (filter === "booked" && c.status !== "booked") return false;
    if (filter === "referred" && c.status !== "referred") return false;
    if (!needle) return true;
    return c.child_alias.toLocaleLowerCase().includes(needle) || (c.parent_alias ?? "").toLocaleLowerCase().includes(needle);
  });
}
