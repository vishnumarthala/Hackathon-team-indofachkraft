import React from "react";
import { Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { useAudioData, visualizeAudio } from "@remotion/media-utils";
import { Body, Card, Kicker, Pill, Rise, Scene, SyntheticNote, Title, useEnter } from "../components/ui";
import { IconCheck, IconPhone } from "../components/icons";
import { C, FONT } from "../theme";
import { cue, intakeStart, VO } from "../timing";

const LANGS = ["Telugu", "Hindi", "English"];
// Turn start times inside the excerpt (seconds), from components/landing/sampleCall.ts minus the cut start.
const TURNS = [
  { at: 0.18, who: "AI intake assistant", text: "What worries you most about Ravi right now?", agent: true },
  { at: 3.63, who: "Parent", text: "He is not talking. He does not look at us and he does not turn when we call his name.", agent: false },
];

const Wave: React.FC<{ live: boolean; start: number }> = ({ live, start }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audio = useAudioData(staticFile(VO.intake.file));
  const N = 28;
  let bars: number[];
  if (live && audio && frame >= start) {
    bars = visualizeAudio({ fps, frame: frame - start, audioData: audio, numberOfSamples: 64, optimizeFor: "speed" })
      .slice(0, N)
      .map((v) => Math.min(1, v * 6));
  } else {
    bars = Array.from({ length: N }, (_, i) => 0.12 + 0.1 * Math.abs(Math.sin(frame / 7 + i * 0.8)));
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, height: 120 }}>
      {bars.map((v, i) => (
        <div key={i} style={{ width: 7, height: 8 + 110 * v, borderRadius: 4, background: C.peach }} />
      ))}
    </div>
  );
};

export const Intake: React.FC = () => {
  const frame = useCurrentFrame();
  const tLink = cue("intake", "The parent gets");
  const tCall = cue("intake", "and talks to");
  const tLang = cue("intake", "in Telugu");
  const start = intakeStart();
  const callMode = useEnter(tCall);
  const langIdx = Math.max(0, Math.min(2, Math.floor((frame - tLang) / 14)));
  const secs = Math.max(0, Math.floor((frame - tCall) / 30)) + 72;

  return (
    <Scene>
      <Sequence from={start} layout="none">
        <Audio src={staticFile(VO.intake.file)} volume={1} />
      </Sequence>

      <Kicker>01 · Before the visit</Kicker>
      <div style={{ marginTop: 14 }}>
        <Title text="An AI intake call, in the parent's language" size={66} delay={3} />
      </div>

      <div style={{ display: "flex", gap: 90, marginTop: 50 }}>
        {/* Phone */}
        <Rise delay={8} y={80}>
          <div
            style={{
              width: 380,
              height: 640,
              borderRadius: 54,
              background: C.navy,
              padding: 16,
              boxSizing: "border-box",
              boxShadow: "0 24px 50px rgba(20,48,59,0.25)",
              position: "relative",
            }}
          >
            <div style={{ width: "100%", height: "100%", borderRadius: 40, background: "#ECE5DA", overflow: "hidden", position: "relative" }}>
              {/* Message view */}
              <div style={{ position: "absolute", inset: 0, padding: 22, opacity: 1 - callMode }}>
                <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 20, color: C.tealDark, marginBottom: 18 }}>
                  WhatsApp · Your therapy centre
                </div>
                <Rise delay={tLink}>
                  <div style={{ background: C.card, borderRadius: 18, padding: 18, fontFamily: FONT.body, fontSize: 21, color: C.ink, lineHeight: 1.35 }}>
                    Hi Priya, before Ravi's first session, please talk to our intake assistant. It only takes a few minutes.
                    <div style={{ marginTop: 12, color: C.teal, fontWeight: 800 }}>Open intake link →</div>
                  </div>
                </Rise>
                <Rise delay={cue("intake", "gives consent")}>
                  <div
                    style={{
                      marginTop: 16,
                      background: C.tealLight,
                      borderRadius: 18,
                      padding: 16,
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      fontFamily: FONT.body,
                      fontWeight: 700,
                      fontSize: 21,
                      color: C.tealDark,
                    }}
                  >
                    <IconCheck size={26} color={C.teal} /> I agree to the recorded call
                  </div>
                </Rise>
              </div>
              {/* Call view */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: C.navy2,
                  opacity: callMode,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  paddingTop: 70,
                }}
              >
                <div
                  style={{
                    width: 120,
                    height: 120,
                    borderRadius: 60,
                    background: C.teal,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: `0 0 0 ${10 + 8 * Math.abs(Math.sin(frame / 10))}px rgba(42,123,128,0.35)`,
                  }}
                >
                  <IconPhone size={56} color={C.cream} />
                </div>
                <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 30, color: C.cream, marginTop: 28 }}>Intake assistant</div>
                <div style={{ fontFamily: FONT.body, fontSize: 22, color: "#9DB3BA", marginTop: 4 }}>
                  {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
                </div>
                <div style={{ marginTop: 40 }}>
                  <Wave live={frame >= start} start={start} />
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 40 }}>
                  {LANGS.map((l, i) => (
                    <Pill
                      key={l}
                      bg={frame >= tLang && i === langIdx ? C.orange : "rgba(255,255,255,0.1)"}
                      color={C.cream}
                      style={{ fontSize: 20 }}
                    >
                      {l}
                    </Pill>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Rise>

        {/* Right column */}
        <div style={{ flex: 1 }}>
          {[
            { d: tLink, t: "Intake link by WhatsApp or email" },
            { d: cue("intake", "gives consent"), t: "Consent first, recorded with the call" },
            { d: tLang, t: "Voice agent speaks Telugu, Hindi or English" },
          ].map((b) => (
            <Rise key={b.t} delay={b.d} x={40} y={0}>
              <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 22 }}>
                <div style={{ width: 46, height: 46, borderRadius: 23, background: C.tealLight, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <IconCheck size={28} color={C.teal} />
                </div>
                <Body size={34} color={C.navy} weight={600}>
                  {b.t}
                </Body>
              </div>
            </Rise>
          ))}

          <Rise delay={start - 12}>
            <Card style={{ marginTop: 24, padding: "28px 34px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    background: C.red,
                    opacity: Math.sin(frame / 6) > 0 ? 1 : 0.3,
                  }}
                />
                <span style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, letterSpacing: 1.2, color: C.muted }}>
                  LIVE · ROLE-PLAY INTAKE CALL
                </span>
              </div>
              {TURNS.map((t) => {
                const at = start + Math.round(t.at * 30);
                const p = interpolate(frame, [at, at + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
                const chars = Math.floor(interpolate(frame, [at, at + t.text.length * 1.1], [0, t.text.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
                return (
                  <div key={t.who} style={{ opacity: p, marginTop: 16 }}>
                    <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 21, color: t.agent ? C.teal : C.rust }}>{t.who}</div>
                    <div style={{ fontFamily: FONT.body, fontSize: 31, color: C.navy, lineHeight: 1.3, marginTop: 2 }}>
                      {t.text.slice(0, chars)}
                    </div>
                  </div>
                );
              })}
            </Card>
          </Rise>
        </div>
      </div>
      <SyntheticNote />
    </Scene>
  );
};
