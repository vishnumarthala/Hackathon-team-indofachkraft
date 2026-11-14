// Class builders shared by components/ui and by class constants in plain .ts modules (no React import).
import { cn } from "./cn";

// Figma: Components › Button (4:2), Primary/Secondary/Ghost/Danger × md/sm × Default/Disabled, optional icon.
// `lg` is a code-only size for the one big mobile action per screen (min-h-12, full-width callers).
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm" | "lg";

/** Figma effect style Focus/ring. */
export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2";

const base =
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg text-center font-semibold transition-colors ${focusRing} ` +
  "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed aria-disabled:pointer-events-none";

// Disabled states keep AA contrast (slate-600 on slate-200 ≈ 6.1:1) instead of fading the brand colour.
const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-teal-700 text-white hover:bg-teal-800 disabled:bg-slate-200 disabled:text-slate-600 aria-disabled:bg-slate-200 aria-disabled:text-slate-600",
  secondary:
    "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:bg-slate-50 disabled:text-slate-500 aria-disabled:bg-slate-50 aria-disabled:text-slate-500",
  ghost: "text-teal-700 hover:bg-teal-50 disabled:text-slate-500 aria-disabled:text-slate-500",
  danger:
    "bg-red-700 text-white hover:bg-red-800 disabled:bg-slate-200 disabled:text-slate-600 aria-disabled:bg-slate-200 aria-disabled:text-slate-600",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-3 py-1 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "min-h-12 px-5 py-3 text-base",
};

/** Class string for a Button look-alike when an element can't be wrapped (prefer `<Button asChild>`). */
export function buttonClasses({ variant = "primary", size = "md", className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(base, variants[variant], sizes[size], className);
}
