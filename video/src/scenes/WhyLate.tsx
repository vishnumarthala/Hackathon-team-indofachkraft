import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Big, Body, Card, CountUp, Kicker, Rise, Scene, Source, Title, useEnter } from "../components/ui";
import { Figure, IconClock, IconDoc, IconPeople } from "../components/icons";
import { C, FONT } from "../theme";
import { cue } from "../timing";

const Reason: React.FC<{ delay: number; icon: React.ReactNode; title: string; sub: string }> = ({ delay, icon, title, sub }) => (
  <Rise delay={delay} x={-40} y={0}>
    <div style={{ display: "flex", alignItems: "center", gap: 26, marginTop: 30 }}>
      <div
        style={{
          width: 84,
          height: 84,
          borderRadius: 24,
          background: C.card,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 6px 18px rgba(20,48,59,0.08)",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 38, color: C.navy }}>{title}</div>
        <Body size={26} color={C.muted}>
          {sub}
        </Body>
      </div>
    </div>
  </Rise>
);

const Bar: React.FC<{ label: string; value: number; max: number; color: string; delay: number }> = ({ label, value, max, color, delay }) => {
  const frame = useCurrentFrame();
  const w = interpolate(frame - delay, [0, 40], [0, value / max], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ marginTop: 18 }}>
      <Body size={24} color={C.ink} weight={600}>
        {label}
      </Body>
      <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 6 }}>
        <div style={{ height: 40, width: 520 * w, background: color, borderRadius: 10 }} />
        <span style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: 40, color }}>
          <CountUp to={value} decimals={value % 1 ? 1 : 0} prefix="+" delay={delay} duration={40} />
        </span>
      </div>
    </div>
  );
};

export const WhyLate: React.FC = () => {
  const tMatters = cue("why-late", "And time matters");
  const tFour = cue("why-late", "Four in ten");
  const tIQ = cue("why-late", "In a randomised");
  const frame = useCurrentFrame();
  const papers = Math.floor(interpolate(frame, [cue("why-late", "and therapists"), cue("why-late", "and therapists") + 40], [0, 5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const right = useEnter(tMatters);

  return (
    <Scene>
      <div style={{ display: "flex", gap: 90, height: "100%" }}>
        <div style={{ flex: 1, paddingTop: 40 }}>
          <Kicker>Why so late?</Kicker>
          <div style={{ marginTop: 14 }}>
            <Title text="The bottleneck is the system." size={66} delay={3} />
          </div>
          <Reason delay={cue("why-late", "Too few")} icon={<IconPeople size={48} />} title="Too few specialists" sub="Developmental paediatricians are scarce" />
          <Reason delay={cue("why-late", "year-long")} icon={<IconClock size={48} />} title="Year-long waitlists" sub="Families wait while the window closes" />
          <Reason
            delay={cue("why-late", "and therapists")}
            icon={
              <div style={{ position: "relative", width: 48, height: 48 }}>
                <IconDoc size={48} color={C.rust} />
                {papers > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      right: -20,
                      top: -18,
                      minWidth: 34,
                      height: 34,
                      borderRadius: 17,
                      background: C.rust,
                      color: C.card,
                      fontFamily: FONT.head,
                      fontWeight: 700,
                      fontSize: 18,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {papers * 8}
                  </div>
                )}
              </div>
            }
            title="Sessions spent on paperwork"
            sub="A 40-item form, filled while watching the child"
          />
        </div>

        <div
          style={{
            flex: 1,
            paddingTop: 40,
            opacity: right,
            transform: `translateX(${(1 - right) * 60}px)`,
          }}
        >
          <Kicker color={C.teal}>And time matters</Kicker>
          <Rise delay={tFour}>
            <Card bg={C.tealLight} style={{ marginTop: 28, boxShadow: "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
                <Big size={88} color={C.teal} style={{ whiteSpace: "nowrap" }}>
                  4 in 10
                </Big>
                <svg width={380} height={100} viewBox="0 0 420 110">
                  {Array.from({ length: 10 }).map((_, i) => {
                    const lit = i < 4 && frame > tFour + 10 + i * 5;
                    return <Figure key={i} x={21 + i * 42} y={100} h={86} color={lit ? C.teal : "#B7CFD0"} />;
                  })}
                </svg>
              </div>
              <Body size={27} style={{ marginTop: 12 }}>
                toddlers diagnosed at 1 to 3 no longer met autism criteria at age 5 to 7
              </Body>
            </Card>
          </Rise>
          <Rise delay={tIQ}>
            <Card style={{ marginTop: 28 }}>
              <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 32, color: C.navy }}>IQ gain after 2 years (randomised trial)</div>
              <Bar label="Early intervention" value={17.6} max={18} color={C.teal} delay={tIQ + 10} />
              <Bar label="Usual care" value={7} max={18} color="#9AA7AC" delay={tIQ + 30} />
            </Card>
          </Rise>
        </div>
      </div>
      <Source delay={tFour}>Sources: Harstad et al., JAMA Pediatrics 2023 (213 children) · Dawson et al., Pediatrics 2010</Source>
    </Scene>
  );
};
