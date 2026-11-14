import { buttonClasses } from "@/components/ui/variants";
// Small fetch helper for the provider/admin client components (ticket 028). API errors stay English
// (contract); components show translated messages chosen by status and mark fields from `details`.
export type ApiResult = { ok: boolean; status: number; json: Record<string, unknown> };

export async function send(url: string, method: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, json: {} };
  }
}

export function fieldKeys(json: Record<string, unknown>): string[] {
  const details = json.details;
  return details && typeof details === "object" ? Object.keys(details as object) : [];
}

export const inputClass =
  "mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 aria-[invalid=true]:border-red-600 sm:text-sm";
export const labelClass = "block text-sm font-medium text-slate-800";
export const buttonClass = buttonClasses();
export const secondaryButtonClass = buttonClasses({ variant: "secondary" });
