import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Big, Body, Card, Kicker, Rise, Scene, Source, Title, useEnter } from "../components/ui";
import { C, FONT } from "../theme";
import { cue } from "../timing";

const AX_W = 1664;
const MAX_AGE = 7.2;
const ax = (age: number) => (age / MAX_AGE) * AX_W;

const Marker: React.FC<{ age: number; delay: number; color: string; big: string; label: string; up?: boolean }> = ({
  age,
  delay,
  color,
  big,
  label,
  up = true,
}) => {
  const p = useEnter(delay, 14);
  const q = useEnter(delay);
  return (
    <div style={{ position: "absolute", left: ax(age), top: 0 }}>
      <div
        style={{
          position: "absolute",
          left: -18,
          top: -18,
          width: 36,
          height: 36,
          borderRadius: 18,
          background: color,
          border: `6px solid ${C.cream}`,
          transform: `scale(${p})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -2,
          width: 4,
          background: color,
          top: up ? -40 * q - 20 : 20,
          height: 40 * q,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -150,
          width: 300,
          textAlign: "center",
          top: up ? -200 : 74,
          opacity: q,
          transform: `translateY(${(1 - q) * (up ? 20 : -20)}px)`,
        }}
      >
        <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 54, color }}>{big}</div>
        <div style={{ fontFamily: FONT.body, fontSize: 25, color: C.ink, lineHeight: 1.25, marginTop: 4 }}>{label}</div>
      </div>
    </div>
  );
};

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const axis = interpolate(frame, [6, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const tNotice = cue("problem", "Parents notice");
  const tWindow = cue("problem", "Support helps");
  const tUS = cue("problem", "Yet the median");
  const tDE = cue("problem", "and in Germany");
  const tGap = cue("problem", "at school entry");
  const t31 = cue("problem", "One in thirty-one");
  const t100 = cue("problem", "About one in a hundred");
  const band = useEnter(tWindow);
  const gap = interpolate(frame, [tGap, tGap + 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <Scene>
      <Kicker>The problem</Kicker>
      <div style={{ marginTop: 18 }}>
        <Title text="The signs appear at 2. Help arrives at 4 to 6." size={70} delay={4} />
      </div>

      <div style={{ position: "absolute", left: 128, top: 560, width: AX_W, height: 4 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: -40,
            height: 80,
            width: ax(3) * band,
            background: C.tealLight,
            borderRadius: 16,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 16,
            top: 56,
            opacity: band,
            fontFamily: FONT.body,
            fontWeight: 800,
            fontSize: 22,
            color: C.teal,
            letterSpacing: 1,
            whiteSpace: "nowrap",
          }}
        >
          THE WINDOW: BEFORE 3
        </div>
        <div style={{ position: "absolute", left: 0, top: 0, height: 4, width: AX_W * axis, background: C.navy, borderRadius: 2 }} />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((a) => (
          <div
            key={a}
            style={{
              position: "absolute",
              left: ax(a) - 20,
              width: 40,
              textAlign: "center",
              top: 18,
              opacity: interpolate(frame, [8 + a * 4, 20 + a * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              fontFamily: FONT.body,
              fontSize: 22,
              color: C.muted,
            }}
          >
            {a}
          </div>
        ))}
        <div style={{ position: "absolute", left: AX_W - 40, top: 46, fontFamily: FONT.body, fontSize: 20, color: C.muted, opacity: axis }}>
          age
        </div>

        <Marker age={2} delay={tNotice} color={C.orange} big="~2 yrs" label="Parents notice the first signs" />
        <Marker age={4} delay={tUS} color={C.navy} big="4 yrs" label="Median diagnosis, US" />
        <Marker age={6.5} delay={tDE} color={C.navy} big="6.5 yrs" label="Average diagnosis, Germany" />

        <div style={{ position: "absolute", left: ax(2), top: 96, width: (ax(6.5) - ax(2)) * gap, height: 4, background: C.red }} />
        <div
          style={{
            position: "absolute",
            left: ax(2),
            width: ax(6.5) - ax(2),
            top: 112,
            textAlign: "center",
            opacity: gap,
            fontFamily: FONT.head,
            fontWeight: 700,
            fontSize: 30,
            color: C.red,
          }}
        >
          Up to 4½ years lost, in the years that matter most
        </div>
      </div>

      <div style={{ position: "absolute", left: 128, right: 128, top: 790, display: "flex", gap: 28 }}>
        {[
          { d: t31, big: "1 in 31", label: "US children have autism (1 in 20 boys)" },
          { d: t100, big: "1 in 100", label: "children worldwide" },
          { d: t100 + 15, big: "$1.4M–2.4M", label: "lifetime cost of support per person" },
        ].map((s) => (
          <Rise key={s.big} delay={s.d} style={{ flex: 1 }}>
            <Card bg={C.navy} style={{ padding: "26px 32px" }}>
              <Big size={60} color={C.peach}>
                {s.big}
              </Big>
              <Body size={25} color="#DCE5E8" style={{ marginTop: 8 }}>
                {s.label}
              </Body>
            </Card>
          </Rise>
        ))}
      </div>
      <Source delay={t31}>Sources: CDC ADDM 2025 · WHO · Höfer et al. 2019 · Buescher et al., JAMA Pediatrics 2014</Source>
    </Scene>
  );
};
