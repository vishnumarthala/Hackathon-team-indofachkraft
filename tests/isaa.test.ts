import { describe, expect, it } from "vitest";
import facp from "@/schemas/facp.json";
import { CASE_SHEET_FIELDS, getCaseSheetField } from "@/lib/caseSheet";
import { ISAA, domainOf, getIsaaItem, ratingLabel } from "@/lib/isaa";

describe("ISAA schema helpers", () => {
  it("has 40 items in 6 domains", () => {
    expect(ISAA.items).toHaveLength(40);
    expect(ISAA.domains.map((d) => `${d.id}:${d.items.length}`).join(",")).toBe(
      "social:9,emotional:5,speech:9,behaviour:7,sensory:6,cognitive:4",
    );
    expect(ISAA.domains.flatMap((d) => d.items)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("labels ratings", () => {
    expect([1, 2, 3, 4, 5].map(ratingLabel)).toEqual(["Rarely", "Sometimes", "Frequently", "Mostly", "Always"]);
    expect(ratingLabel(3)).toBe("Frequently");
    expect(() => ratingLabel(6)).toThrow("Invalid ISAA rating: 6");
  });

  it("finds items and their domain", () => {
    expect(getIsaaItem(15)?.text).toBe("Acquired speech and lost it");
    expect(getIsaaItem("29")?.text).toBe("Engages in self-injurious behaviour");
    expect(getIsaaItem(41)).toBeUndefined();
    expect(domainOf(29)?.name).toBe("Behaviour patterns");
    expect(domainOf("40")?.id).toBe("cognitive");
    expect(domainOf(0)).toBeUndefined();
    expect(ISAA.red_flag_items).toEqual({ "15": "lost_speech", "29": "self_injury" });
  });

  it("has the FACP bands and the 15 case-sheet fields in order", () => {
    expect(facp.bands.map((b) => `${b.id}/${b.min}-${b.max}`)).toEqual([
      "typical/80-100",
      "borderline/60-79",
      "moderate/40-59",
      "severe/0-39",
    ]);
    expect(CASE_SHEET_FIELDS).toHaveLength(15);
    expect(CASE_SHEET_FIELDS[0]).toMatchObject({ id: "consent_given", type: "boolean", label: "Consent given" });
    expect(getCaseSheetField("self_injury")?.label).toBe("Self-injury");
    expect(getCaseSheetField("nope")).toBeUndefined();
  });
});
