import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Body, Card, Kicker, Rise, Scene, Title, useEnter } from "../components/ui";
import { Figure, IconClock, IconPin } from "../components/icons";
import { C, FONT } from "../theme";
import { cue } from "../timing";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const tSigns = cue("hook", "Priya noticed");
  const tWait = cue("hook", "Now they are");
  const tHow = cue("hook", "nobody can tell");

  const scene = useEnter(0);
  const bubble = useEnter(tSigns - 6);
  const months = Math.floor(interpolate(frame, [tWait, tWait + 150], [0, 11], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const turn = Math.sin(frame / 14) * 2;

  return (
    <Scene>
      <div style={{ display: "flex", height: "100%", alignItems: "center", gap: 80 }}>
        <div style={{ flex: 1.15 }}>
          <Rise delay={4}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
              <IconPin />
              <span style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 28, color: C.rust, letterSpacing: 1.5 }}>
                STUTTGART, TODAY
              </span>
            </div>
          </Rise>
          <Title text="Ravi is 2½." size={104} delay={10} />
          <Title text="He has no words yet." size={104} delay={cue("hook", "and he has") - 4} color={C.rust} />
          <Rise delay={tSigns}>
            <Body size={36} style={{ marginTop: 36, maxWidth: 820 }}>
              His mother Priya noticed the signs months ago. The family speaks Telugu at home.
            </Body>
          </Rise>
        </div>

        <div style={{ flex: 1, position: "relative", height: 760 }}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 40,
              background: C.tealLight,
              opacity: scene,
              transform: `scale(${0.92 + 0.08 * scene})`,
              overflow: "hidden",
            }}
          >
            <svg width="100%" height="100%" viewBox="0 0 700 760">
              <rect x={0} y={470} width={700} height={290} fill="#D3E5E5" />
              <Figure x={200} y={490} h={320} color={C.navy} />
              <g transform={`rotate(${turn} 420 490)`}>
                <Figure x={420} y={490} h={165} color={C.orange} flip />
              </g>
              <rect x={452} y={462} width={44} height={28} rx={6} fill={C.teal} />
            </svg>
            <div
              style={{
                position: "absolute",
                left: 270,
                top: 120,
                opacity: bubble,
                transform: `scale(${0.6 + 0.4 * bubble})`,
                transformOrigin: "left bottom",
              }}
            >
              <div
                style={{
                  background: C.card,
                  borderRadius: 24,
                  padding: "18px 28px",
                  fontFamily: FONT.head,
                  fontWeight: 700,
                  fontSize: 38,
                  color: C.navy,
                  boxShadow: "0 8px 20px rgba(0,0,0,0.08)",
                }}
              >
                “Ravi?” <span style={{ color: C.muted, fontWeight: 500, fontSize: 26 }}>…no response</span>
              </div>
            </div>
          </div>

          <Rise delay={tWait} y={60} style={{ position: "absolute", right: -30, bottom: -90 }}>
            <Card style={{ width: 420, padding: "26px 30px" }} accent={C.orange}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <IconClock size={38} color={C.rust} />
                <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 26, color: C.rust, letterSpacing: 1 }}>WAITLIST</div>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 10 }}>
                <span style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 84, color: C.navy }}>{months + 1}</span>
                <span style={{ fontFamily: FONT.body, fontSize: 30, color: C.ink }}>months and counting</span>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                {MONTHS.map((m, i) => (
                  <div
                    key={m}
                    style={{
                      flex: 1,
                      height: 12,
                      borderRadius: 6,
                      background: i <= months ? C.orange : C.line,
                    }}
                  />
                ))}
              </div>
              <Rise delay={tHow}>
                <Body size={24} color={C.muted} style={{ marginTop: 14 }}>
                  Next available appointment: unknown
                </Body>
              </Rise>
            </Card>
          </Rise>
        </div>
      </div>
      <div style={{ position: "absolute", left: 128, top: 72 }}>
        <Kicker delay={0} color={C.navy}>
          CareThread
        </Kicker>
      </div>
    </Scene>
  );
};
