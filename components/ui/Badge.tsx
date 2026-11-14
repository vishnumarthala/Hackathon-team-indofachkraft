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

// `md` is the roomier pill of the family-portal cards (Figma Appointment card 9:344).
export type BadgeSize = "sm" | "md";
const sizes: Record<BadgeSize, string> = { sm: "px-2 py-0.5 font-medium", md: "px-3 py-1 font-semibold" };

export function badgeClasses(tone: BadgeTone = "neutral", className?: string, size: BadgeSize = "sm"): string {
  return cn("inline-flex items-center rounded-full text-xs", sizes[size], tones[tone], className);
}

/** Figma Badge: a short status label. Text is the meaning; colour only reinforces it. */
export function Badge({ tone = "neutral", size = "sm", className, ...rest }: ComponentProps<"span"> & { tone?: BadgeTone; size?: BadgeSize }) {
  return <span className={badgeClasses(tone, className, size)} {...rest} />;
}
