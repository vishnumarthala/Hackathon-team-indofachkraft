import caseSheetJson from "@/schemas/case-sheet.json";

export type CaseSheetFieldType = "boolean" | "integer" | "string";
export type CaseSheetField = { id: string; type: CaseSheetFieldType; label: string; description: string };

export const CASE_SHEET_FIELDS = caseSheetJson.fields as CaseSheetField[];

export function getCaseSheetField(id: string): CaseSheetField | undefined {
  return CASE_SHEET_FIELDS.find((field) => field.id === id);
}
