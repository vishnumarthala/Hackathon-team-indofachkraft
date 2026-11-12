import { describe, expect, it } from "vitest";
import {
  FACP_ACTIONS,
  ISAA_BAND_LABELS,
  SUGGESTION_LABEL,
  collectRedFlags,
  facpBand,
  formatIsaaScore,
  isaaBand,
  recommend,
  scoreIsaa,
  type ScoringFact,
} from "@/lib/scoring";

function facts(make: (id: number) => Omit<ScoringFact, "item_id">): ScoringFact[] {
  return Array.from({ length: 40 }, (_, i) => ({ item_id: String(i + 1), ...make(i + 1) }));
}

const allConfirmed = (value: number) => facts(() => ({ value, status: "confirmed" }));

describe("isaaBand", () => {
  it("uses gap-free boundaries", () => {
    expect([40, 69, 70, 106, 107, 153, 154, 200].map(isaaBand)).toEqual([
      "no_autism",
      "no_autism",
      "mild",
      "mild",
      "moderate",
      "moderate",
      "severe",
      "severe",
    ]);
  });

  it("re-exports schema labels", () => {
    expect(ISAA_BAND_LABELS).toEqual({
      no_autism: "Below cut-off (under 70)",
      mild: "Mild (70-106)",
      moderate: "Moderate (107-153)",
      severe: "Severe (154-200)",
    });
  });
});

describe("facpBand", () => {
  it("uses gap-free boundaries and accepts null", () => {
    expect([0, 39, 40, 59, 60, 79, 80, 100].map(facpBand)).toEqual([
      "severe",
      "severe",
      "moderate",
      "moderate",
      "borderline",
      "borderline",
      "typical",
      "typical",
    ]);
    expect(facpBand(null)).toBeNull();
  });

  it("holds the exact action texts", () => {
    expect(FACP_ACTIONS).toEqual({
      typical: "Home program and parent counselling, re-screen in 3 months",
      borderline: "IEP and home program, review in 3 months",
      moderate: "IEP and regular therapy sessions",
      severe: "IEP and referral to specialist (Phase 3)",
    });
  });
});

describe("scoreIsaa", () => {
  it("gives a final total and band when all 40 items are confirmed or edited", () => {
    const score = scoreIsaa(facts((id) => ({ value: 3, status: id % 2 ? "confirmed" : "edited" })));
    expect(score).toMatchObject({
      rated: 40,
      confirmed: 40,
      total: 120,
      minimum_total: 120,
      suggested_total: 120,
      band: "moderate",
      minimum_band: "moderate",
      suggested_band: "moderate",
    });
  });

  it("is provisional while items are unconfirmed", () => {
    const score = scoreIsaa(
      facts((id) =>
        id <= 10
          ? { value: null, status: "suggested" }
          : id <= 20
            ? { value: 3, status: "suggested" }
            : { value: 3, status: "confirmed" },
      ),
    );
    expect(score).toMatchObject({
      rated: 30,
      confirmed: 20,
      total: null,
      band: null,
      minimum_total: 80,
      minimum_band: "mild",
      suggested_total: 100,
      suggested_band: "mild",
    });
  });

  it("never lets AI suggestions raise the lower bound", () => {
    const score = scoreIsaa(facts(() => ({ value: 5, status: "suggested" })));
    expect(score.minimum_total).toBe(40);
    expect(score.suggested_total).toBe(200);
    expect(score.total).toBeNull();
  });

  it("counts missing, invalid, duplicate and non-ISAA rows safely", () => {
    const score = scoreIsaa([
      { item_id: "1", value: 4, status: "confirmed" },
      { item_id: "1", value: 5, status: "confirmed" },
      { item_id: "2", value: 7, status: "confirmed" },
      { item_id: "3", value: 2.5, status: "edited" },
      { item_id: "4", value: null, status: "confirmed" },
      { item_id: "0", value: 5, status: "confirmed" },
      { item_id: "41", value: 5, status: "confirmed" },
      { item_id: "01", value: 5, status: "confirmed" },
      { item_id: "main_concern", value: 5, status: "confirmed" },
    ]);
    expect(score).toMatchObject({ rated: 1, confirmed: 1, total: null, minimum_total: 43, suggested_total: 43 });
  });

  it("scores domains in schema order from the values passed in", () => {
    const score = scoreIsaa(
      facts((id) => (id === 1 ? { value: 5, status: "suggested" } : { value: 2, status: "confirmed" })),
    );
    expect(score.by_domain.map((d) => d.domain_id)).toEqual([
      "social",
      "emotional",
      "speech",
      "behaviour",
      "sensory",
      "cognitive",
    ]);
    expect(score.by_domain[0]).toEqual({
      domain_id: "social",
      name: "Social relationship and reciprocity",
      score: 21,
      max: 45,
      rated: 9,
      confirmed: 8,
    });
    expect(score.by_domain.map((d) => d.max)).toEqual([45, 25, 45, 35, 30, 20]);
  });

  it("leaves domains empty when nothing is rated", () => {
    const score = scoreIsaa([]);
    expect(score.minimum_total).toBe(40);
    expect(score.minimum_band).toBe("no_autism");
    expect(score.by_domain.every((d) => d.score === 0 && d.rated === 0 && d.confirmed === 0)).toBe(true);
  });
});

describe("collectRedFlags", () => {
  it("flags items 15 and 29 from a rating of 2", () => {
    const isaaFacts = [
      { item_id: "15", value: 2, status: "confirmed" },
      { item_id: "29", value: 1, status: "confirmed" },
    ];
    expect(collectRedFlags({ isaaFacts })).toEqual([{ type: "lost_speech", source: "isaa_item", item_id: "15" }]);
    expect(collectRedFlags({ isaaFacts: [{ item_id: "29", value: 3, status: "edited" }] })).toEqual([
      { type: "self_injury", source: "isaa_item", item_id: "29" },
    ]);
    expect(collectRedFlags({ isaaFacts: [{ item_id: "15", value: null, status: "suggested" }] })).toEqual([]);
  });

  it("keeps the first flag per type in source order and ignores other", () => {
    const flags = collectRedFlags({
      isaaFacts: [{ item_id: "29", value: 4, status: "confirmed" }],
      extractionRedFlags: [
        { type: "other", segment_id: "s1", quote: "q0" },
        { type: "self_injury", segment_id: "s2", quote: "q1" },
        { type: "lost_speech", segment_id: "s3", quote: "q2" },
      ],
      intake: {
        lost_speech: true,
        self_injury: true,
        brief_red_flags: [{ type: "lost_speech", turn_id: "t4", quote: "q3" }],
      },
    });
    expect(flags).toEqual([
      { type: "lost_speech", source: "extraction", quote: "q2", segment_id: "s3" },
      { type: "self_injury", source: "isaa_item", item_id: "29" },
    ]);
  });

  it("prefers intake brief flags over intake booleans", () => {
    expect(
      collectRedFlags({
        intake: {
          self_injury: true,
          lost_speech: true,
          brief_red_flags: [
            { type: "other", turn_id: "t1", quote: "x" },
            { type: "self_injury", turn_id: "t7", quote: "he hits his head" },
          ],
        },
      }),
    ).toEqual([
      { type: "lost_speech", source: "intake" },
      { type: "self_injury", source: "intake", quote: "he hits his head", turn_id: "t7" },
    ]);
  });

  it("returns nothing without input", () => {
    expect(collectRedFlags({})).toEqual([]);
    expect(collectRedFlags({ intake: { lost_speech: false } })).toEqual([]);
  });
});

describe("recommend", () => {
  const lowFinal = scoreIsaa(allConfirmed(1));
  const highFinal = scoreIsaa(allConfirmed(3));

  it("recommends referral for a final total of 70 or more", () => {
    const r = recommend({ isaa: highFinal, facpScore: 85, redFlags: [] });
    expect(r).toEqual({
      referral_recommended: true,
      reasons: ["ISAA total 120 is 70 or more"],
      action: "Home program and parent counselling, re-screen in 3 months + referral to specialist (Phase 3)",
      isaa_band: "moderate",
      facp_band: "typical",
      provisional: false,
    });
  });

  it("uses the confirmed lower bound while provisional", () => {
    const isaa = scoreIsaa(facts((id) => (id <= 5 ? { value: null, status: "suggested" } : { value: 2, status: "confirmed" })));
    const r = recommend({ isaa, facpScore: 30, redFlags: [] });
    expect(r.provisional).toBe(true);
    expect(isaa.minimum_total).toBe(75);
    expect(r.reasons).toEqual(["ISAA total at least 75 is 70 or more", "FACP score 30 is below 40"]);
    expect(r.action).toBe("IEP and referral to specialist (Phase 3)");
    expect(r.isaa_band).toBe("mild");
  });

  it("does not trigger the ISAA rule from AI suggestions alone", () => {
    const isaa = scoreIsaa(facts(() => ({ value: 5, status: "suggested" })));
    expect(recommend({ isaa, facpScore: null, redFlags: [] })).toEqual({
      referral_recommended: false,
      reasons: [],
      action: "Enter the FACP score to get a suggested action",
      isaa_band: null,
      facp_band: null,
      provisional: true,
    });
  });

  it("lists red flag reasons in order", () => {
    const r = recommend({
      isaa: lowFinal,
      facpScore: 65,
      redFlags: [
        { type: "self_injury", source: "intake" },
        { type: "lost_speech", source: "isaa_item", item_id: "15" },
      ],
    });
    expect(r.reasons).toEqual(["Red flag: lost speech", "Red flag: self-injury"]);
    expect(r.action).toBe("IEP and home program, review in 3 months + referral to specialist (Phase 3)");
    expect(r.isaa_band).toBe("no_autism");
  });

  it("refers without FACP when a rule triggers", () => {
    const r = recommend({ isaa: lowFinal, facpScore: null, redFlags: [{ type: "lost_speech", source: "intake" }] });
    expect(r.action).toBe("Referral to specialist (Phase 3)");
  });

  it("gives the FACP action alone without referral", () => {
    expect(recommend({ isaa: lowFinal, facpScore: 50, redFlags: [] }).action).toBe("IEP and regular therapy sessions");
    expect(recommend({ isaa: lowFinal, facpScore: 60, redFlags: [] }).action).toBe(
      "IEP and home program, review in 3 months",
    );
  });

  it("refers on a severe FACP score without appending the referral suffix", () => {
    const r = recommend({ isaa: lowFinal, facpScore: 39, redFlags: [] });
    expect(r.referral_recommended).toBe(true);
    expect(r.reasons).toEqual(["FACP score 39 is below 40"]);
    expect(r.action).toBe("IEP and referral to specialist (Phase 3)");
    expect(recommend({ isaa: lowFinal, facpScore: 40, redFlags: [] }).referral_recommended).toBe(false);
  });

  it("uses the exact ISAA threshold of 70", () => {
    const at69 = scoreIsaa(facts((id) => ({ value: id <= 29 ? 2 : 1, status: "confirmed" })));
    const at70 = scoreIsaa(facts((id) => ({ value: id <= 30 ? 2 : 1, status: "confirmed" })));
    expect([at69.total, at70.total]).toEqual([69, 70]);
    expect(recommend({ isaa: at69, facpScore: null, redFlags: [] }).referral_recommended).toBe(false);
    expect(recommend({ isaa: at70, facpScore: null, redFlags: [] }).reasons).toEqual(["ISAA total 70 is 70 or more"]);
  });
});

describe("formatIsaaScore", () => {
  const provisional = scoreIsaa(
    facts((id) =>
      id <= 10 ? { value: null, status: "suggested" } : id <= 20 ? { value: 3, status: "suggested" } : { value: 3, status: "confirmed" },
    ),
  );

  it("formats a final score with its band label", () => {
    expect(formatIsaaScore(scoreIsaa(allConfirmed(3)))).toBe("ISAA total: 120 · Moderate (107-153)");
    expect(formatIsaaScore(scoreIsaa(allConfirmed(3)), { showSuggested: true })).toBe(
      "ISAA total: 120 · Moderate (107-153)",
    );
  });

  it("formats a provisional score without the AI total by default", () => {
    expect(formatIsaaScore(provisional)).toBe("ISAA total: at least 80 (provisional - 20 of 40 confirmed)");
  });

  it("adds the AI total only when asked", () => {
    expect(formatIsaaScore(provisional, { showSuggested: true })).toBe(
      "ISAA total: at least 80 (provisional - 20 of 40 confirmed; AI-suggested total 100)",
    );
  });
});

it("exports the suggestion label", () => {
  expect(SUGGESTION_LABEL).toBe("Suggested by DoctorNearMe - the therapist decides");
});
