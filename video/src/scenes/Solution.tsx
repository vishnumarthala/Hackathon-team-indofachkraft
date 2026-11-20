import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Body, Rise, Scene, useEnter } from "../components/ui";
import { Logo } from "../components/Logo";
import { C, FONT } from "../theme";
import { cue } from "../timing";

const PEOPLE = [
  { phrase: "the family", name: "Priya & Ravi", role: "The family", note: "Telugu-speaking, Stuttgart", color: C.teal },
  { phrase: "the therapist", name: "Lakshmi", role: "The therapist", note: "Early intervention therapist", color: C.orange },
  { phrase: "the centre", name: "Anand", role: "The centre", note: "Owns a therapy centre chain", color: C.navy },
  { phrase: "and the specialist", name: "Dr. Weber", role: "The specialist", note: "Developmental paediatrician", color: C.rust },
] as const;

const X = [250, 690, 1130, 1570];
const Y = 700;

export const Solution: React.FC = () => {
  const frame = useCurrentFrame();
  const tThread = cue("solution", "One thread");
  const draw = interpolate(frame, [tThread, cue("solution", "and the specialist") + 10], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const logoUp = useEnter(tThread - 20);

  return (
    <Scene>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 300 - 170 * logoUp,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div style={{ transform: `scale(${1.25 - 0.35 * logoUp})` }}>
          <Logo size={150} delay={4} />
        </div>
        <Rise delay={cue("solution", "an AI assistant")}>
          <Body size={40} color={C.ink} style={{ textAlign: "center", marginTop: 30 }}>
            The AI assistant for <b>early intervention centres</b>
          </Body>
        </Rise>
        <Rise delay={cue("solution", "to get children")}>
          <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 46, color: C.teal, marginTop: 12 }}>
            Get kids into support sooner.
          </div>
        </Rise>
      </div>

      <svg style={{ position: "absolute", left: 0, top: 0 }} width={1920} height={1080}>
        <path
          d={`M ${X[0]} ${Y} C ${X[0] + 220} ${Y - 120}, ${X[1] - 220} ${Y + 120}, ${X[1]} ${Y} S ${X[2] - 220} ${Y - 120}, ${X[2]} ${Y} S ${X[3] - 220} ${Y + 120}, ${X[3]} ${Y}`}
          stroke={C.orange}
          strokeWidth={6}
          fill="none"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={draw}
        />
      </svg>

      {PEOPLE.map((p, i) => {
        const d = cue("solution", p.phrase, -8);
        return (
          <div key={p.name} style={{ position: "absolute", left: X[i] - 170, top: Y - 70, width: 340, textAlign: "center" }}>
            <Rise delay={d} scale y={20}>
              <div
                style={{
                  width: 140,
                  height: 140,
                  borderRadius: 70,
                  margin: "0 auto",
                  background: p.color,
                  border: `8px solid ${C.cream}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: FONT.head,
                  fontWeight: 800,
                  fontSize: 46,
                  color: C.cream,
                  boxShadow: "0 10px 26px rgba(20,48,59,0.18)",
                }}
              >
                {p.name
                  .split(/[ .&]+/)
                  .filter((w) => w && w !== "Dr")
                  .map((w) => w[0])
                  .join("")}
              </div>
              <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, letterSpacing: 1.4, color: p.color, marginTop: 18 }}>
                {p.role.toUpperCase()}
              </div>
              <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 36, color: C.navy, marginTop: 4 }}>{p.name}</div>
              <Body size={24} color={C.muted}>
                {p.note}
              </Body>
            </Rise>
          </div>
        );
      })}
    </Scene>
  );
};
