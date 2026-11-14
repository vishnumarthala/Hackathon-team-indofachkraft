import type { ComponentProps } from "react";
import { cn } from "./cn";

// Figma: Components › Badge (4:83), six tones.
export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  brand: "bg-teal-50 text-teal-800",
  success: "bg-emerald-50 text-emerald-800",
  warning: "bg-amber-50 text-amber-900",
  danger: "bg-red-50 text-red-700",
  info: "bg-sky-50 text-sky-900",
};

export function badgeClasses(tone: BadgeTone = "neutral", className?: string): string {
  return cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tones[tone], className);
}

/** Figma Badge: a short status label. Text is the meaning; colour only reinforces it. */
export function Badge({ tone = "neutral", className, ...rest }: ComponentProps<"span"> & { tone?: BadgeTone }) {
  return <span className={badgeClasses(tone, className)} {...rest} />;
}
