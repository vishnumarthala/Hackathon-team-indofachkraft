// Ticket 049 FR-2: the booking agent's prompts per language (server only: bundles every catalogue).
import type { Locale } from "@/lib/i18n/config";
import type { AgentPrompt } from "../../prompts";
import { EN } from "./en";
import { HI } from "./hi";
import { TE } from "./te";

export const BOOKING_PROMPTS: Record<Locale, AgentPrompt> = { en: EN, hi: HI, te: TE };
