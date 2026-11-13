// Ticket 049 FR-2: how every agent prompt names and handles each language (shared by the four agents' prompts). Every
// Hindi or Telugu word in a prompt comes from messages/{hi,te}.json, so native speakers review all of it in
// messages/REVIEW.md; these notes are English instructions to the model.
import type { Locale } from "@/lib/i18n/config";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import type { PromptLanguage } from "./prompts";

export const PROMPT_LANGUAGES: Record<Locale, PromptLanguage> = {
  en: { code: "en", name: "English", notes: "" },
  hi: {
    code: "hi",
    name: `Hindi (${hi.voiceAgents.languages.hi})`,
    notes:
      "Use simple, everyday spoken Hindi as families in Hyderabad speak it (Hindustani, not formal or Sanskritised Hindi). Common English words such as doctor, therapist, clinic, school or video are fine. Say numbers as digits. Address the parent with the polite form of you.",
  },
  te: {
    code: "te",
    name: `Telugu (${te.voiceAgents.languages.te})`,
    notes:
      "Use simple, everyday spoken Telugu as families in Telangana speak it, not formal written (granthika) Telugu. Common English words such as doctor, therapist, clinic, school or video are fine. Say numbers as digits. Address the parent with the polite form of you.",
  },
};
