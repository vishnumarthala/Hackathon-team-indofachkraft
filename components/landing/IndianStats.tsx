import { getT } from "@/lib/i18n/server";
import { Reveal } from "./Reveal";

/** 050 FR-3: Indian statistics only, each linked to the source listed in specs/grill/doctornearme-pmf-check.md. */
export const INDIAN_STAT_SOURCES = {
  inclen: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6057634/",
  age: "https://www.ovid.com/jnls/ijph/fulltext/10.4103/ijph.ijph_1801_21~age-at-diagnosis-for-autism-spectrum-disorders-does-it",
  rci: "https://cdnbbsr.s3waas.gov.in/s34f4eeef3a8c90dfceaddd5c6d64e4ebb/uploads/2025/07/202507141090347321.pdf",
} as const;

const STATS = [
  { key: "autism", source: "inclen", tone: "warm" },
  { key: "ndd", source: "inclen", tone: "teal" },
  { key: "age", source: "age", tone: "plain" },
  { key: "pros", source: "rci", tone: "plain" },
] as const;

const SOURCE_LABELS = { inclen: "sourceInclen", age: "sourceAge", rci: "sourceRci" } as const;

const CARD_TONES = {
  warm: "bg-[#fff1e8] ring-1 ring-[#ef6f5e]/25",
  teal: "bg-teal-50 ring-1 ring-teal-200",
  plain: "bg-[#f8f6f1] ring-1 ring-[#0b1f1d]/[0.06]",
} as const;

const VALUE_TONES = { warm: "text-[#c2410c]", teal: "text-teal-700", plain: "text-[#0b1f1d]" } as const;

/** Four stat cards with "Sources:" (linked) under the block. Used on `/` and `/for-centres`. */
export async function IndianStats() {
  const t = await getT("landing.stats");
  return (
    <div data-testid="indian-stats">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((st, i) => (
          <Reveal key={st.key} delay={i * 80} className={`lp-card rounded-3xl p-6 ${CARD_TONES[st.tone]}`}>
            <p className={`lp-display mb-3 text-5xl leading-none ${VALUE_TONES[st.tone]}`}>{t(`${st.key}Value`)}</p>
            <p className="text-sm leading-relaxed text-slate-600">{t(`${st.key}Label`)}</p>
          </Reveal>
        ))}
      </div>
      <p className="mt-6 text-xs leading-relaxed text-slate-500">
        {t("sources")}{" "}
        {(Object.keys(SOURCE_LABELS) as (keyof typeof SOURCE_LABELS)[]).map((source, i) => (
          <span key={source}>
            {i > 0 && " · "}
            <a
              href={INDIAN_STAT_SOURCES[source]}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-teal-800"
            >
              {t(SOURCE_LABELS[source])}
            </a>
          </span>
        ))}
      </p>
    </div>
  );
}
