// Ticket 023: button styles of the document components in the family portal (teal, rounded) and the provider
// case workspace (053: the shared teal Button classes). Safe anywhere.
import { buttonClasses as uiButtonClasses } from "@/components/ui/variants";
import { primaryButtonClass, secondaryButtonClass } from "@/components/family/PhoneOtpForm";

export type Tone = "family" | "provider";

export function buttonClasses(tone: Tone): { primary: string; secondary: string } {
  if (tone === "family") return { primary: `${primaryButtonClass} sm:w-auto`, secondary: secondaryButtonClass };
  return {
    primary: uiButtonClasses(),
    secondary:
      "inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50",
  };
}
