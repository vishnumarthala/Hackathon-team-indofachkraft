// Ticket 048 FR-2: plain milestone guidance for children under 18 months (no questions). DRAFT PENDING CLINICAL REVIEW
// (NFR-2, docs/screen-recommendations.md). The text is translated (`screen.under18m.milestones.<key>`); this list
// fixes the order and the age each milestone is usually reached by.
export type Milestone = { key: "smiles" | "babbles" | "name" | "points" | "words"; byMonths: string };

export const MILESTONES: readonly Milestone[] = [
  { key: "smiles", byMonths: "2" },
  { key: "babbles", byMonths: "6" },
  { key: "name", byMonths: "9" },
  { key: "points", byMonths: "12-15" },
  { key: "words", byMonths: "15" },
];
