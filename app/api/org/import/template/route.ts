import { requireProviderApi } from "@/lib/authz";
import { toCsv } from "@/lib/import/csv";
import { TEMPLATE_COLUMNS } from "@/lib/import/validate";

export const dynamic = "force-dynamic";

// 047 FR-1: the CSV template (header row only, UTF-8 with BOM so Excel shows Telugu/Hindi names correctly).
export async function GET() {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  return new Response(`\uFEFF${toCsv([[...TEMPLATE_COLUMNS]])}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="doctornearme-children-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}
