import isaaJson from "@/schemas/isaa.json";

export type DomainId = "social" | "emotional" | "speech" | "behaviour" | "sensory" | "cognitive";

export type IsaaItem = { id: number; domain: DomainId; text: string };
export type IsaaDomain = { id: DomainId; name: string; items: number[] };
export type IsaaScaleStep = { value: number; label: string; range: string };
export type IsaaBandDef = { id: string; min: number; max: number; label: string };

export type IsaaInstrument = {
  instrument: "ISAA";
  scale: IsaaScaleStep[];
  domains: IsaaDomain[];
  items: IsaaItem[];
  bands: IsaaBandDef[];
  red_flag_items: Record<string, string>;
};

export const ISAA = isaaJson as IsaaInstrument;

export function getIsaaItem(id: number | string): IsaaItem | undefined {
  return ISAA.items.find((item) => item.id === Number(id));
}

export function ratingLabel(rating: number): string {
  const step = ISAA.scale.find((s) => s.value === rating);
  if (!step) throw new Error(`Invalid ISAA rating: ${rating}`);
  return step.label;
}

export function domainOf(itemId: number | string): IsaaDomain | undefined {
  const item = getIsaaItem(itemId);
  return item ? ISAA.domains.find((d) => d.id === item.domain) : undefined;
}
