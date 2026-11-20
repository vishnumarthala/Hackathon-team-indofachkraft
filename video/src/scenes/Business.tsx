import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { Big, Body, Card, CountUp, Kicker, Pill, Rise, Scene, Source, Title } from "../components/ui";
import { C, FONT } from "../theme";
import { cue } from "../timing";

const Price: React.FC<{ delay: number; market: string; price: string; unit: string; who: string; color: string }> = ({
  delay,
  market,
  price,
  unit,
  who,
  color,
}) => (
  <Rise delay={delay} x={-40} y={0}>
    <Card accent={color} style={{ marginBottom: 26, padding: "24px 32px" }}>
      <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, letterSpacing: 1.4, color }}>{market}</div>
      <Big size={58} style={{ marginTop: 6 }}>
        {price}
      </Big>
      <Body size={25} color={C.ink} style={{ marginTop: 4 }}>
        {unit}
      </Body>
      <Body size={22} color={C.muted} style={{ marginTop: 6 }}>
        {who}
      </Body>
    </Card>
  </Rise>
);

const Step: React.FC<{ n: number; delay: number; title: string; sub: string }> = ({ n, delay, title, sub }) => (
  <Rise delay={delay} x={40} y={0}>
    <div style={{ display: "flex", alignItems: "center", gap: 22, marginBottom: 22 }}>
      <div
        style={{
          width: 62,
          height: 62,
          borderRadius: 31,
          background: C.teal,
          color: C.cream,
          fontFamily: FONT.head,
          fontWeight: 800,
          fontSize: 30,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {n}
      </div>
      <div>
        <div style={{ fontFamily: FONT.head, fontWeight: 700, fontSize: 34, color: C.navy }}>{title}</div>
        <Body size={23} color={C.muted}>
          {sub}
        </Body>
      </div>
    </div>
  </Rise>
);

export const Business: React.FC = () => {
  const frame = useCurrentFrame();
  const tArr = cue("business", "one hundred to");
  const line = interpolate(frame, [cue("business", "We start"), cue("business", "in year one")], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Scene>
      <Kicker>Business and go-to-market</Kicker>
      <div style={{ marginTop: 14 }}>
        <Title text="Centres pay. We start where our network is." size={66} delay={3} />
      </div>

      <div style={{ display: "flex", gap: 70, marginTop: 44 }}>
        <div style={{ width: 640 }}>
          <Price
            delay={cue("business", "In India")}
            market="INDIA"
            price="₹5,000–15,000"
            unit="per centre per month"
            who="Early intervention and autism centres"
            color={C.orange}
          />
          <Price
            delay={cue("business", "In Germany")}
            market="GERMANY"
            price="€99–149"
            unit="per clinician per month"
            who="SPZ, autism centres, practices"
            color={C.teal}
          />
        </div>

        <div style={{ flex: 1, position: "relative" }}>
          <div style={{ position: "absolute", left: 29, top: 30, width: 4, height: 190 * line, background: C.tealLight }} />
          <Step n={1} delay={cue("business", "We start")} title="3 pilot centres" sub="From our network, 4-week pilots" />
          <Step n={2} delay={cue("business", "fifty Indian")} title="50 Indian centres" sub="Via therapist associations and centre-software partners" />
          <Step n={3} delay={cue("business", "five German")} title="5 German pilot sites" sub="SPZ, reached through Indian parent communities" />
          <Rise delay={tArr} y={40}>
            <Card bg={C.navy} style={{ marginTop: 12, padding: "24px 32px" }}>
              <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, letterSpacing: 1.4, color: C.peach }}>YEAR 1 GOAL</div>
              <Big size={64} color={C.cream} style={{ marginTop: 6 }}>
                €<CountUp to={100} delay={tArr} />k–<CountUp to={150} delay={tArr} />k ARR
              </Big>
            </Card>
          </Rise>
          <Rise delay={tArr + 30} y={20}>
            <div style={{ display: "flex", gap: 14, marginTop: 20 }}>
              <Pill bg={C.sand} color={C.navy} style={{ fontSize: 22 }}>
                TAM: $1.5B → $5.1B AI scribe market (2025–2030)
              </Pill>
              <Pill bg={C.sand} color={C.navy} style={{ fontSize: 22 }}>
                SAM ≈ €5M / year
              </Pill>
            </div>
          </Rise>
        </div>
      </div>
      <Source delay={tArr}>Sources: TBRC 2026 · SWP 2025 · Prices and SAM: our estimates, benchmarked on therapy AI scribes</Source>
    </Scene>
  );
};
