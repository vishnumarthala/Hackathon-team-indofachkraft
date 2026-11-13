// Ticket 023: button styles of the document components in the family portal (teal, rounded) and the provider
// case workspace (slate). Safe anywhere.
import { primaryButtonClass, secondaryButtonClass } from "@/components/family/PhoneOtpForm";

export type Tone = "family" | "provider";

export function buttonClasses(tone: Tone): { primary: string; secondary: string } {
  if (tone === "family") return { primary: `${primaryButtonClass} sm:w-auto`, secondary: secondaryButtonClass };
  return {
    primary: "inline-flex min-h-11 items-center rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50",
    secondary:
      "inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50",
  };
}
