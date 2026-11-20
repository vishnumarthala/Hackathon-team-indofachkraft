import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Body, Card, Kicker, Pill, Rise, Scene, SyntheticNote, Title, useEnter } from "../components/ui";
import { IconCheck, IconFlag, IconPlay } from "../components/icons";
import { C, FONT } from "../theme";
import { cue } from "../timing";

// Real items and quotes from the demo fixtures (demo/fixtures/gemini/extract.json, schemas/isaa.json).
const ROWS = [
  { id: 1, item: "Has poor eye contact", rating: 4, quote: "he does not look at us when we talk", ts: "0:20" },
  { id: 6, item: "Unable to respond to social cues", rating: 4, quote: "He does not turn when we call his name", ts: "0:34" },
  { id: 15, item: "Acquired speech and lost it", rating: 4, quote: "at age 2 he said a few words… then slowly he stopped talking", ts: "1:00" },
  { id: 18, item: "Engages in echolalic speech", rating: 4, quote: "He repeats lines from cartoons, again and again", ts: "1:55" },
  { id: 31, item: "Unusually sensitive to sensory stimuli", rating: 4, quote: "He covers his ears at the mixer", ts: "2:21" },
];

const Row: React.FC<{ r: (typeof ROWS)[number]; fill: number; evidence: number; confirm: number }> = ({ r, fill, evidence, confirm }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [fill, fill + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ev = interpolate(frame, [evidence, evidence + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ok = frame >= confirm;
  const okP = interpolate(frame, [confirm, confirm + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        padding: "13px 22px",
        borderBottom: `2px solid ${C.line}`,
        background: ok ? `rgba(47,143,91,${0.07 * okP})` : "transparent",
      }}
    >
      <div style={{ width: 52, fontFamily: FONT.head, fontWeight: 700, fontSize: 24, color: C.muted }}>#{r.id}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: FONT.body, fontWeight: 700, fontSize: 25, color: C.navy }}>{r.item}</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 6,
            opacity: p,
            background: `rgba(224,122,63,${0.14 * ev})`,
            borderRadius: 8,
            padding: "2px 8px",
            marginLeft: -8,
          }}
        >
          <span style={{ fontFamily: FONT.body, fontStyle: "italic", fontSize: 22, color: C.ink }}>“{r.quote}”</span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontFamily: FONT.body,
              fontWeight: 800,
              fontSize: 19,
              color: C.teal,
              background: C.tealLight,
              borderRadius: 6,
              padding: "2px 8px",
              whiteSpace: "nowrap",
            }}
          >
            <IconPlay size={14} /> {r.ts}
          </span>
        </div>
      </div>
      <div style={{ opacity: p, transform: `scale(${0.7 + 0.3 * p})` }}>
        <Pill bg={C.navy} color={C.cream} style={{ fontSize: 21 }}>
          {r.rating} · Mostly
        </Pill>
      </div>
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          border: `3px solid ${ok ? C.green : C.line}`,
          background: ok ? C.green : C.card,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ transform: `scale(${okP})` }}>
          <IconCheck size={30} color={C.card} />
        </div>
      </div>
    </div>
  );
};

export const Forms: React.FC = () => {
  const frame = useCurrentFrame();
  const tSession = cue("forms", "During the session");
  const tSplit = cue("forms", "separates");
  const tFill = cue("forms", "and fills all");
  const tEvidence = cue("forms", "Every suggested");
  const tConfirm = cue("forms", "The therapist confirms");
  const tDecides = cue("forms", "AI documents");
  const screen = useEnter(tSession - 10);
  const confirmed = ROWS.filter((_, i) => frame >= tConfirm + i * 7).length;
  const rated = Math.round(interpolate(frame, [tFill, tFill + 70], [0, 15], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));

  return (
    <Scene>
      <Kicker color={C.teal}>02 · From the session</Kicker>
      <div style={{ marginTop: 14 }}>
        <Title text="The form fills itself. The therapist confirms." size={66} delay={3} />
      </div>

      <div style={{ display: "flex", gap: 40, marginTop: 44 }}>
        <div style={{ width: 520, flexShrink: 0 }}>
          <Rise delay={8}>
            <Card accent={C.orange} style={{ padding: "26px 30px" }}>
              <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, letterSpacing: 1.2, color: C.rust }}>PRE-SESSION BRIEF</div>
              <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 34, color: C.navy, marginTop: 6 }}>Ravi, 40 months</div>
              <Body size={22} color={C.muted} style={{ marginTop: 6 }}>
                From the intake call · parent-reported
              </Body>
              {[
                { q: "Said a few words at 2, then stopped talking", label: "Lost speech" },
                { q: "Hits his own head with his hand when upset", label: "Self-injury" },
              ].map((f, i) => (
                <Rise key={f.label} delay={cue("forms", "red flags") + i * 8} x={-30} y={0}>
                  <div style={{ display: "flex", gap: 14, marginTop: 18, alignItems: "flex-start" }}>
                    <IconFlag size={28} style={{ marginTop: 4, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 24, color: C.red }}>Red flag: {f.label}</div>
                      <Body size={22} color={C.ink}>
                        {f.q}
                      </Body>
                    </div>
                  </div>
                </Rise>
              ))}
            </Card>
          </Rise>

          <Rise delay={tDecides} y={50}>
            <Card bg={C.navy} style={{ marginTop: 28, padding: "30px 34px" }}>
              <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 44, color: C.cream, lineHeight: 1.15 }}>
                AI documents.
                <br />
                <span style={{ color: C.peach }}>The clinician decides.</span>
              </div>
            </Card>
          </Rise>
        </div>

        <div
          style={{
            flex: 1,
            opacity: screen,
            transform: `translateY(${(1 - screen) * 60}px)`,
          }}
        >
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "20px 22px", background: C.sand }}>
              <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 28, color: C.navy }}>ISAA review · Session 1</div>
              <div style={{ flex: 1 }} />
              <Rise delay={tSplit} y={0} x={20}>
                <div style={{ display: "flex", gap: 8 }}>
                  <Pill bg={C.tealLight} color={C.tealDark} style={{ fontSize: 19 }}>
                    Therapist
                  </Pill>
                  <Pill bg="#F8E3D5" color={C.rust} style={{ fontSize: 19 }}>
                    Parent
                  </Pill>
                </div>
              </Rise>
              <div style={{ fontFamily: FONT.body, fontWeight: 700, fontSize: 22, color: C.ink }}>
                Rated <span style={{ fontFamily: FONT.head, fontSize: 28 }}>{rated}</span> / 40
              </div>
            </div>
            {ROWS.map((r, i) => (
              <Row key={r.id} r={r} fill={tFill + i * 10} evidence={tEvidence + i * 6} confirm={tConfirm + i * 7} />
            ))}
            <div style={{ display: "flex", alignItems: "center", padding: "18px 22px", gap: 12 }}>
              <Body size={23} color={C.muted}>
                Score uses confirmed items only
              </Body>
              <div style={{ flex: 1 }} />
              <Body size={24} color={C.navy} weight={700}>
                Confirmed by therapist: {confirmed} / {ROWS.length}
              </Body>
            </div>
          </Card>
        </div>
      </div>
      <SyntheticNote />
    </Scene>
  );
};
