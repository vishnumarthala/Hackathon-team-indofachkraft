"use client";

import { secondaryButton } from "@/components/screen/view";
import { useLocale, useT } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";

/**
 * Ticket 049 FR-4: the agent does not speak the page language. Says so ("Voice is available in English. You can also
 * answer by tapping in Telugu.") and offers both options; the voice call never falls back to English silently.
 * `message` is the sentence for this page (tap, skip the call, or type); `alternative` the non-voice option.
 */
export function VoiceLanguageChoice({
  message,
  alternative,
  onVoiceInEnglish,
  disabled = false,
}: {
  message: string;
  alternative: { label: string; onClick: () => void };
  onVoiceInEnglish: () => void;
  disabled?: boolean;
}) {
  const t = useT("voiceAgents.fallback");
  return (
    <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4" data-testid="voice-language-choice">
      <p className="font-medium text-amber-950">{message}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" className={secondaryButton} onClick={onVoiceInEnglish} disabled={disabled}>
          {t("voiceInEnglish")}
        </button>
        <button type="button" className={secondaryButton} onClick={alternative.onClick} disabled={disabled}>
          {alternative.label}
        </button>
      </div>
    </div>
  );
}

/** "The assistant speaks Telugu." (default: the page language) next to the voice disclosure. */
export function CallLanguageNote({ className = "text-sm text-slate-700", language }: { className?: string; language?: Locale }) {
  const t = useT("voiceAgents");
  const locale = useLocale();
  return (
    <p className={className} data-testid="voice-call-language">
      {t("callLanguage", { language: t(`languages.${language ?? locale}`) })}
    </p>
  );
}
