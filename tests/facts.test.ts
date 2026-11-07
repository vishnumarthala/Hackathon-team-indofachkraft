import { describe, expect, it } from "vitest";
import {
  BulkActionSchema,
  FactActionSchema,
  RATE_BEFORE_CONFIRM,
  applyFactAction,
  bulkAuditAction,
  bulkTargets,
  ratingOf,
  toScoringFacts,
  type FactStatus,
} from "@/lib/facts";
import { scoreIsaa } from "@/lib/scoring";

const fact = (id: string, value: number | null, status: FactStatus) => ({ id, value, status });

describe("applyFactAction (FR-6)", () => {
  it("confirm keeps the value and sets status confirmed", () => {
    expect(applyFactAction({ value: 3, status: "suggested" }, { action: "confirm" })).toEqual({
      value: 3,
      status: "confirmed",
      auditAction: "fact.confirmed",
    });
  });

  it("confirm with a null value is rejected with 422", () => {
    expect(applyFactAction({ value: null, status: "suggested" }, { action: "confirm" })).toEqual({
      status: 422,
      error: RATE_BEFORE_CONFIRM,
    });
  });

  it("edit sets the new value and status edited", () => {
    expect(applyFactAction({ value: 2, status: "suggested" }, { action: "edit", value: 4 })).toEqual({
      value: 4,
      status: "edited",
      auditAction: "fact.edited",
    });
  });

  it("edit of an unrated item rates it as edited", () => {
    expect(applyFactAction({ value: null, status: "suggested" }, { action: "edit", value: 1 })).toEqual({
      value: 1,
      status: "edited",
      auditAction: "fact.edited",
    });
  });

  it("same-value edit of a suggestion counts as confirm", () => {
    expect(applyFactAction({ value: 3, status: "suggested" }, { action: "edit", value: 3 })).toEqual({
      value: 3,
      status: "confirmed",
      auditAction: "fact.confirmed",
    });
  });

  it("same-value edit of an already confirmed item is an edit", () => {
    expect(applyFactAction({ value: 3, status: "confirmed" }, { action: "edit", value: 3 })).toEqual({
      value: 3,
      status: "edited",
      auditAction: "fact.edited",
    });
  });
});

describe("bulkTargets (FR-8)", () => {
  const facts = [
    fact("a", 3, "suggested"),
    fact("b", null, "suggested"),
    fact("c", 2, "confirmed"),
    fact("d", 4, "edited"),
    fact("e", 5, "suggested"),
  ];

  it("confirm_suggested confirms only suggested items with a value", () => {
    expect(bulkTargets(facts, { action: "confirm_suggested" })).toEqual([
      { id: "a", value: 3, status: "confirmed" },
      { id: "e", value: 5, status: "confirmed" },
    ]);
    expect(bulkAuditAction({ action: "confirm_suggested" })).toBe("facts.bulk_confirmed");
  });

  it("rate_unrated sets every null item to 1 as edited", () => {
    expect(bulkTargets(facts, { action: "rate_unrated", value: 1 })).toEqual([{ id: "b", value: 1, status: "edited" }]);
    expect(bulkAuditAction({ action: "rate_unrated", value: 1 })).toBe("facts.bulk_rated");
  });

  it("both bulk actions together decide all items, so the total is final", () => {
    const all = Array.from({ length: 40 }, (_, i) => fact(String(i + 1), i % 4 === 0 ? null : 2, "suggested"));
    const after = new Map(all.map((f) => [f.id, { ...f }]));
    for (const t of [
      ...bulkTargets(all, { action: "rate_unrated", value: 1 }),
      ...bulkTargets(all, { action: "confirm_suggested" }),
    ]) {
      after.set(t.id, { id: t.id, value: t.value, status: t.status });
    }
    const score = scoreIsaa([...after.values()].map((f) => ({ item_id: f.id, value: f.value, status: f.status })));
    expect(score.confirmed).toBe(40);
    expect(score.total).toBe(10 * 1 + 30 * 2);
  });
});

describe("request schemas", () => {
  it("accepts confirm and edit 1..5, rejects other values", () => {
    expect(FactActionSchema.safeParse({ action: "confirm" }).success).toBe(true);
    expect(FactActionSchema.safeParse({ action: "edit", value: 5 }).success).toBe(true);
    expect(FactActionSchema.safeParse({ action: "edit", value: 7 }).success).toBe(false);
    expect(FactActionSchema.safeParse({ action: "edit", value: 2.5 }).success).toBe(false);
    expect(FactActionSchema.safeParse({ action: "delete" }).success).toBe(false);
  });

  it("bulk rate_unrated only allows value 1", () => {
    expect(BulkActionSchema.safeParse({ action: "confirm_suggested" }).success).toBe(true);
    expect(BulkActionSchema.safeParse({ action: "rate_unrated", value: 1 }).success).toBe(true);
    expect(BulkActionSchema.safeParse({ action: "rate_unrated", value: 2 }).success).toBe(false);
  });
});

describe("value helpers", () => {
  it("ratingOf keeps only integer ratings 1..5", () => {
    expect([ratingOf(1), ratingOf(5), ratingOf(0), ratingOf(6), ratingOf("3"), ratingOf(null)]).toEqual([
      1,
      5,
      null,
      null,
      null,
      null,
    ]);
  });

  it("toScoringFacts maps DB rows to scoring input", () => {
    expect(toScoringFacts([{ item_id: "4", value: 3, status: "edited" }, { item_id: "5", value: true, status: "suggested" }])).toEqual([
      { item_id: "4", value: 3, status: "edited" },
      { item_id: "5", value: null, status: "suggested" },
    ]);
  });
});
