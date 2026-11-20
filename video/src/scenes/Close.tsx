import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Big, Body, Kicker, Rise, Scene, useEnter } from "../components/ui";
import { Logo } from "../components/Logo";
import { C, FONT } from "../theme";
import { cue } from "../timing";
import { LIVE_LINK, TEAM_LINE } from "../config";

const Stat: React.FC<{ delay: number; big: string; text: string }> = ({ delay, big, text }) => (
  <Rise delay={delay} x={-40} y={0}>
    <div style={{ display: "flex", alignItems: "center", gap: 40, padding: "26px 0", borderTop: "2px solid rgba(255,255,255,0.12)" }}>
      <Big size={72} color={C.cream} style={{ width: 330, flexShrink: 0 }}>
        {big}
      </Big>
      <Body size={30} color="#C9D6DA" style={{ flex: 1 }}>
        {text}
      </Body>
    </div>
  </Rise>
);

export const Close: React.FC = () => {
  const frame = useCurrentFrame();
  const tAsk = cue("close", "Our ask");
  const tEnd = cue("close", "CareThread.");
  const out = interpolate(frame, [tEnd - 12, tEnd], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const end = useEnter(tEnd);

  return (
    <Scene dark>
      <div style={{ opacity: out, display: "flex", gap: 80, height: "100%" }}>
        <div style={{ flex: 1.1, paddingTop: 30 }}>
          <Kicker color={C.peach}>Why now</Kicker>
          <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 66, color: C.cream, marginTop: 14, marginBottom: 30 }}>
            The technology is ready.
          </div>
          <Stat delay={cue("close", "Voice AI")} big="90+" text="languages in ElevenLabs speech recognition, Telugu and Hindi included" />
          <Stat delay={cue("close", "two hundred")} big="280,000" text="Indian nationals in Germany, 3.3x since 2015" />
          <Stat delay={cue("close", "two hundred") + 25} big="39%" text="clinician burnout after 30 days with an AI scribe, down from 52%" />
        </div>
        <div style={{ flex: 0.9, display: "flex", alignItems: "center" }}>
          <Rise delay={tAsk} y={60}>
            <div style={{ background: C.rust, borderRadius: 28, padding: "44px 48px", boxShadow: "0 20px 50px rgba(0,0,0,0.3)" }}>
              <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 26, letterSpacing: 1.5, color: "#FBD9C2" }}>OUR ASK</div>
              <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 56, color: C.cream, lineHeight: 1.1, marginTop: 12 }}>
                3 pilot centres
              </div>
              <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 40, color: C.cream, lineHeight: 1.2, marginTop: 14, opacity: 0.95 }}>
                + introductions to SPZ clinicians
              </div>
              <Body size={24} color="#FBD9C2" style={{ marginTop: 20 }}>
                Full-time if pilots convert: yes.
              </Body>
            </div>
          </Rise>
        </div>
      </div>

      {frame >= tEnd - 12 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Logo size={170} delay={tEnd} dark />
          <div
            style={{
              marginTop: 50,
              opacity: interpolate(frame, [tEnd + 25, tEnd + 45], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              fontFamily: FONT.head,
              fontWeight: 700,
              fontSize: 52,
              color: C.cream,
              textAlign: "center",
            }}
          >
            When the signs appear at <span style={{ color: C.peach }}>2</span>,
            <br />
            help should not wait until <span style={{ color: C.peach }}>6</span>.
          </div>
          <div
            style={{
              marginTop: 60,
              opacity: end * interpolate(frame, [tEnd + 50, tEnd + 70], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              fontFamily: FONT.body,
              fontSize: 28,
              color: "#9DB3BA",
              textAlign: "center",
              lineHeight: 1.6,
            }}
          >
            {TEAM_LINE}
            {LIVE_LINK ? ` · ${LIVE_LINK}` : ""}
            <br />
            Built on ElevenLabs and Google Gemini
          </div>
        </div>
      )}
    </Scene>
  );
};
