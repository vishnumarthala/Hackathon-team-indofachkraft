import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { Body, Card, Kicker, Pill, Rise, Scene, SyntheticNote, Title, useEnter } from "../components/ui";
import { IconDoc, IconPlay, IconSend } from "../components/icons";
import { C, FONT } from "../theme";
import { cue } from "../timing";

// From demo/fixtures/gemini/parent-summary.json (parent name swapped to match the video's story).
const TELUGU =
  "ప్రియ గారు, ఈ రోజు రవి గురించి మీరు చెప్పిన విషయాలకు ధన్యవాదాలు. రవి మీ కళ్ళలోకి చూడటం తక్కువగా ఉందని, పేరు పిలిస్తే తిరగడం లేదని మీరు చెప్పారు.";

export const Handoff: React.FC = () => {
  const frame = useCurrentFrame();
  const tClick = cue("handoff", "one click");
  const tAsk = cue("handoff", "ask the case");
  const tNever = cue("handoff", "The family never");
  const fly = interpolate(frame, [tClick + 14, tClick + 44], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const press = frame >= tClick && frame < tClick + 8 ? 0.94 : 1;
  const arrived = fly >= 1;
  const banner = useEnter(tNever);

  return (
    <Scene>
      <Kicker color={C.navy}>03 · When it is serious</Kicker>
      <div style={{ marginTop: 14 }}>
        <Title text="One click hands the whole case to a specialist." size={66} delay={3} />
      </div>

      {/* Parent voice summary */}
      <div style={{ position: "absolute", left: 128, top: 330, width: 480 }}>
        <Rise delay={cue("handoff", "parents get")}>
          <Card accent={C.teal} style={{ padding: "24px 28px" }}>
            <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 21, letterSpacing: 1.2, color: C.teal }}>
              FOR PARENTS · VOICE SUMMARY
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
              <div style={{ width: 52, height: 52, borderRadius: 26, background: C.teal, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <IconPlay size={24} color={C.cream} />
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {Array.from({ length: 30 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 5,
                      borderRadius: 3,
                      height: 8 + 26 * Math.abs(Math.sin(i * 1.7 + frame / 6)),
                      background: i < ((frame / 3) % 30) ? C.teal : "#B7CFD0",
                    }}
                  />
                ))}
              </div>
              <Pill bg={C.tealLight} color={C.tealDark} style={{ fontSize: 18 }}>
                తెలుగు
              </Pill>
            </div>
            <div style={{ fontFamily: FONT.telugu, fontSize: 23, color: C.ink, lineHeight: 1.6, marginTop: 14 }}>{TELUGU}</div>
          </Card>
        </Rise>
      </div>

      {/* Send button */}
      <div style={{ position: "absolute", left: 680, top: 470 }}>
        <Rise delay={tClick - 20} scale>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              background: C.orange,
              color: C.card,
              borderRadius: 18,
              padding: "20px 30px",
              fontFamily: FONT.head,
              fontWeight: 700,
              fontSize: 30,
              transform: `scale(${press})`,
              boxShadow: "0 12px 26px rgba(224,122,63,0.35)",
            }}
          >
            <IconSend /> Send referral
          </div>
        </Rise>
      </div>

      {/* Flying packet */}
      {fly > 0 && !arrived && (
        <div
          style={{
            position: "absolute",
            left: interpolate(fly, [0, 1], [720, 1240]),
            top: 560 - Math.sin(fly * Math.PI) * 160,
            transform: `rotate(${(1 - fly) * -10}deg)`,
          }}
        >
          <Card style={{ padding: "14px 18px", display: "flex", gap: 10, alignItems: "center" }}>
            <IconDoc size={34} color={C.rust} />
            <span style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, color: C.navy }}>Referral packet</span>
          </Card>
        </div>
      )}

      {/* Specialist */}
      <div style={{ position: "absolute", left: 1150, top: 330, width: 642 }}>
        <Rise delay={tClick - 10} x={40} y={0}>
          <Card style={{ padding: "24px 28px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  background: C.rust,
                  color: C.cream,
                  fontFamily: FONT.head,
                  fontWeight: 800,
                  fontSize: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                W
              </div>
              <div>
                <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 30, color: C.navy }}>Dr. Weber</div>
                <Body size={21} color={C.muted}>
                  Developmental paediatrician · SPZ
                </Body>
              </div>
            </div>
            <div
              style={{
                marginTop: 18,
                padding: "14px 18px",
                borderRadius: 14,
                background: arrived ? "#F8E3D5" : C.sand,
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: arrived ? 1 : 0.5,
              }}
            >
              <IconDoc size={32} color={C.rust} />
              <Body size={22} color={C.navy} weight={700}>
                {arrived ? "Referral packet: intake, transcript, ISAA with evidence" : "Waiting for referral…"}
              </Body>
            </div>

            <Rise delay={tAsk}>
              <div style={{ marginTop: 20, fontFamily: FONT.body, fontWeight: 800, fontSize: 20, letterSpacing: 1.2, color: C.muted }}>ASK THE CASE</div>
              <div
                style={{
                  marginTop: 8,
                  marginLeft: "auto",
                  width: "fit-content",
                  background: C.navy,
                  color: C.cream,
                  borderRadius: "18px 18px 4px 18px",
                  padding: "12px 18px",
                  fontFamily: FONT.body,
                  fontSize: 24,
                }}
              >
                When did speech regress?
              </div>
            </Rise>
            <Rise delay={tAsk + 20}>
              <div
                style={{
                  marginTop: 10,
                  background: C.tealLight,
                  borderRadius: "18px 18px 18px 4px",
                  padding: "12px 18px",
                  fontFamily: FONT.body,
                  fontSize: 23,
                  color: C.ink,
                  lineHeight: 1.35,
                }}
              >
                At age 2 Ravi said a few words (amma, nanna, ball), then slowly stopped talking.{" "}
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontWeight: 800,
                    fontSize: 19,
                    color: C.teal,
                    background: C.card,
                    borderRadius: 6,
                    padding: "1px 8px",
                  }}
                >
                  <IconPlay size={13} /> Session 1 · 1:00
                </span>
              </div>
            </Rise>
          </Card>
        </Rise>
      </div>

      <div
        style={{
          position: "absolute",
          left: 128,
          right: 128,
          bottom: 110,
          opacity: banner,
          transform: `translateY(${(1 - banner) * 30}px)`,
          textAlign: "center",
          fontFamily: FONT.head,
          fontWeight: 800,
          fontSize: 50,
          color: C.navy,
        }}
      >
        The family <span style={{ color: C.rust }}>never repeats</span> their story.
      </div>
      <SyntheticNote />
    </Scene>
  );
};
