import React from "react";
import { useCurrentFrame } from "remotion";
import { Card, Kicker, Rise, Scene, Source, Title, useEnter } from "../components/ui";
import { IconCheck, IconX } from "../components/icons";
import { C, FONT } from "../theme";
import { cue } from "../timing";

type Cell = string | true | false;
// Condensed from the deck's competition table (public product information, Nov 2026).
const COLS = ["CareThread", "Heidi Health", "Therapy scribes", "CentralReach"];
const ROWS: { cap: string; phrase: string; cells: Cell[] }[] = [
  { cap: "Scored developmental forms", phrase: "scored developmental", cells: ["ISAA, 40 items", "Custom templates", "SOAP notes", "ABA skills, US"] },
  { cap: "Evidence and time per item", phrase: "with evidence", cells: [true, "Not advertised", false, false] },
  { cap: "AI call to parents before visit", phrase: "parent calls", cells: [true, "Calls in beta", false, false] },
  { cap: "Telugu and Hindi", phrase: "in Indian languages", cells: ["Voice-first", "110 languages", "English-first", false] },
  { cap: "Handoff to specialist", phrase: "a case memory", cells: ["Case memory, ask the case", "Referral letters", false, false] },
];
const WIDTHS = [440, 360, 288, 288, 288];

const CellView: React.FC<{ v: Cell; hero: boolean }> = ({ v, hero }) => {
  if (v === true) return <IconCheck size={36} color={hero ? C.peach : C.green} />;
  if (v === false) return <IconX size={30} color="#A9B2B5" />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {hero && <IconCheck size={30} color={C.peach} />}
      <span style={{ fontFamily: FONT.body, fontSize: 23, color: hero ? C.cream : C.ink, fontWeight: hero ? 700 : 400 }}>{v}</span>
    </div>
  );
};

export const Different: React.FC = () => {
  const frame = useCurrentFrame();
  const tOthers = cue("different", "General AI scribes");
  const tUs = cue("different", "CareThread is built");
  const hero = useEnter(tUs);

  return (
    <Scene>
      <Kicker>Why 10x better</Kicker>
      <div style={{ marginTop: 14 }}>
        <Title text="Strong tools. None built for this job." size={66} delay={3} />
      </div>

      <div style={{ marginTop: 40, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            left: WIDTHS[0],
            top: -14,
            width: WIDTHS[1],
            height: 78 * (ROWS.length + 1) + 28,
            background: C.navy,
            borderRadius: 22,
            opacity: hero,
            transform: `scaleY(${0.9 + 0.1 * hero})`,
            boxShadow: "0 18px 40px rgba(20,48,59,0.25)",
          }}
        />
        <div style={{ display: "flex", height: 78, alignItems: "center", position: "relative" }}>
          <div style={{ width: WIDTHS[0] }} />
          {COLS.map((c, i) => {
            const d = i === 0 ? tUs : tOthers + i * 4;
            return (
              <div key={c} style={{ width: WIDTHS[i + 1], paddingLeft: 26, boxSizing: "border-box" }}>
                <Rise delay={d} y={14}>
                  <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: i === 0 ? 34 : 26, color: i === 0 ? C.peach : C.muted }}>{c}</div>
                </Rise>
              </div>
            );
          })}
        </div>
        {ROWS.map((r) => {
          const d = cue("different", r.phrase);
          const lit = frame >= d;
          return (
            <div key={r.cap} style={{ display: "flex", height: 78, alignItems: "center", position: "relative", borderTop: `2px solid ${C.line}` }}>
              <div
                style={{
                  width: WIDTHS[0],
                  fontFamily: FONT.body,
                  fontWeight: 700,
                  fontSize: 27,
                  color: lit ? C.navy : C.muted,
                }}
              >
                {r.cap}
              </div>
              {r.cells.map((v, i) => (
                <div key={i} style={{ width: WIDTHS[i + 1], paddingLeft: 26, boxSizing: "border-box" }}>
                  <Rise delay={i === 0 ? d : tOthers + 10} y={10}>
                    <CellView v={v} hero={i === 0} />
                  </Rise>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <Rise delay={cue("different", "Every hour")} y={40}>
        <Card bg={C.navy} style={{ marginTop: 54, display: "flex", alignItems: "center", gap: 36, padding: "26px 36px" }}>
          <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 36, color: C.peach, whiteSpace: "nowrap" }}>Every hour saved</div>
          <div style={{ fontFamily: FONT.body, fontSize: 30, color: C.cream }}>on forms goes to the next child on the waitlist.</div>
        </Card>
      </Rise>
      <Source delay={tOthers}>Based on public product information, Nov 2026. Therapy scribes: Twofold, ScribePT.</Source>
    </Scene>
  );
};
