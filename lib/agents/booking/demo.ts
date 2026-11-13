// Ticket 049 (server only): the DEMO_MODE booking conversation in a call language, from the catalogue.
import type { Locale } from "@/lib/i18n/config";
import { agentTexts } from "../call-language";
import type { BookingDemoScript } from "./demo-script";

export function bookingDemoScript(language: Locale): BookingDemoScript {
  const text = agentTexts(language);
  const { types, modes, partsOfDay, choices, localities, answers } = text.lexicon;
  return {
    language,
    area: localities.banjaraHills.split(",")[0].trim(),
    lines: { greeting: text.booking.firstMessage, ...text.booking.demo },
    lexicon: { answers, types, modes, partsOfDay, choices, localities },
  };
}
