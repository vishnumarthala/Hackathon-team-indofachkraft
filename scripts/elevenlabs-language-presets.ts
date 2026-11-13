// Ticket 049: prints the Hindi and Telugu language presets of a voice agent (first message + system prompt per
// language) from lib/agents/<agent>/prompts, for the ElevenLabs dashboard or the agents API. Nothing is sent anywhere.
// Usage:
//   npm run -s agents:presets -- <screen|booking|generic_intake|followup> [--md] [--voice-hi=<voice id>] [--voice-te=<voice id>]
// Default output: the JSON body for `PATCH https://api.elevenlabs.io/v1/convai/agents/<agent id>` (header xi-api-key),
// which only sets `conversation_config.language_presets` (the English base prompt stays as configured by hand).
// `--md`: the same texts as Markdown, to paste into Agent > Languages > <language> in the dashboard and to review.
import { AGENT_PROMPTS } from "../lib/agents/prompts-all";
import { LANGUAGE_AGENTS, type LanguageAgent } from "../lib/agents/languages";

const PRESET_LANGUAGES = ["hi", "te"] as const;

function main() {
  const args = process.argv.slice(2);
  const agent = args.find((a) => !a.startsWith("--")) as LanguageAgent | undefined;
  if (!agent || !(LANGUAGE_AGENTS as readonly string[]).includes(agent)) {
    console.error(`usage: npm run -s agents:presets -- <${LANGUAGE_AGENTS.join("|")}> [--md] [--voice-hi=<id>] [--voice-te=<id>]`);
    process.exit(1);
  }
  const voice = (lang: string) => args.find((a) => a.startsWith(`--voice-${lang}=`))?.split("=")[1];
  const prompts = AGENT_PROMPTS[agent];

  if (args.includes("--md")) {
    for (const lang of PRESET_LANGUAGES) {
      const p = prompts[lang];
      console.log(`## ${agent}: ${lang}\n\n### First message\n\n\`\`\`\n${p.firstMessage}\n\`\`\`\n\n### System prompt\n\n\`\`\`\n${p.systemPrompt}\n\`\`\`\n`);
    }
    return;
  }

  const presets = Object.fromEntries(
    PRESET_LANGUAGES.map((lang) => {
      const p = prompts[lang];
      const voiceId = voice(lang);
      return [
        lang,
        {
          overrides: {
            agent: { language: lang, first_message: p.firstMessage, prompt: { prompt: p.systemPrompt } },
            ...(voiceId ? { tts: { voice_id: voiceId } } : {}),
          },
        },
      ];
    }),
  );
  console.log(JSON.stringify({ conversation_config: { language_presets: presets } }, null, 2));
}

main();
