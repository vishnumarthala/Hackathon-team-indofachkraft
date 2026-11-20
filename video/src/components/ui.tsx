import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, PAD } from "../theme";

export function useEnter(delay = 0, damping = 200, durationInFrames?: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping }, durationInFrames });
}

export const Rise: React.FC<{
  delay?: number;
  y?: number;
  x?: number;
  scale?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ delay = 0, y = 36, x = 0, scale = false, style, children }) => {
  const p = useEnter(delay);
  return (
    <div
      style={{
        opacity: p,
        transform: `translate(${(1 - p) * x}px, ${(1 - p) * y}px) scale(${scale ? 0.85 + 0.15 * p : 1})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Kicker: React.FC<{ children: React.ReactNode; color?: string; delay?: number }> = ({
  children,
  color = C.rust,
  delay = 0,
}) => (
  <Rise delay={delay} y={16}>
    <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 26, letterSpacing: 1.5, color, textTransform: "uppercase" }}>
      {children}
    </div>
  </Rise>
);

/** Headline whose words slide up one after another. */
export const Title: React.FC<{ text: string; delay?: number; size?: number; color?: string; stagger?: number; style?: React.CSSProperties }> = ({
  text,
  delay = 0,
  size = 76,
  color = C.navy,
  stagger = 3,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: size, lineHeight: 1.08, color, letterSpacing: -1, ...style }}>
      {text.split(" ").map((w, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 200 } });
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: 6 }}>
            <span style={{ display: "inline-block", transform: `translateY(${(1 - p) * 100}%)`, opacity: p }}>
              {w}
              {"\u00A0"}
            </span>
          </span>
        );
      })}
    </div>
  );
};

export const CountUp: React.FC<{
  to: number;
  from?: number;
  delay?: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  thousands?: boolean;
}> = ({ to, from = 0, delay = 0, duration = 36, decimals = 0, prefix = "", suffix = "", thousands = true }) => {
  const frame = useCurrentFrame();
  const v = interpolate(frame - delay, [0, duration], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const s = v.toFixed(decimals);
  const out = thousands ? Number(s).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : s;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {out}
      {suffix}
    </span>
  );
};

export const Source: React.FC<{ children: React.ReactNode; dark?: boolean; delay?: number }> = ({ children, dark, delay = 20 }) => (
  <div style={{ position: "absolute", left: PAD, right: PAD, bottom: 56 }}>
    <Rise delay={delay} y={0}>
      <div style={{ fontFamily: FONT.body, fontSize: 20, color: dark ? "#8FA3AB" : "#8C969A" }}>{children}</div>
    </Rise>
  </div>
);

/** Slowly drifting soft circles behind each scene, so nothing is ever fully static. */
export const Backdrop: React.FC<{ dark?: boolean; tint?: string }> = ({ dark, tint }) => {
  const frame = useCurrentFrame();
  const bg = dark ? C.navy : tint ?? C.cream;
  const a = dark ? "rgba(224,122,63,0.10)" : "rgba(42,123,128,0.07)";
  const b = dark ? "rgba(42,123,128,0.16)" : "rgba(224,122,63,0.07)";
  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: 900,
          height: 900,
          borderRadius: "50%",
          background: a,
          right: -260 + Math.sin(frame / 90) * 40,
          top: -380 + Math.cos(frame / 110) * 30,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 640,
          height: 640,
          borderRadius: "50%",
          background: b,
          left: -240 + Math.cos(frame / 100) * 30,
          bottom: -360 + Math.sin(frame / 80) * 30,
        }}
      />
    </AbsoluteFill>
  );
};

export const Card: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
  accent?: string;
  bg?: string;
}> = ({ children, style, accent, bg = C.card }) => (
  <div
    style={{
      background: bg,
      borderRadius: 22,
      padding: "30px 34px",
      boxShadow: "0 10px 30px rgba(20,48,59,0.08)",
      borderTop: accent ? `8px solid ${accent}` : undefined,
      boxSizing: "border-box",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Body: React.FC<{ children: React.ReactNode; size?: number; color?: string; weight?: number; style?: React.CSSProperties }> = ({
  children,
  size = 30,
  color = C.ink,
  weight = 400,
  style,
}) => <div style={{ fontFamily: FONT.body, fontSize: size, color, fontWeight: weight, lineHeight: 1.35, ...style }}>{children}</div>;

export const Big: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties }> = ({
  children,
  size = 84,
  color = C.navy,
  style,
}) => <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: size, color, lineHeight: 1, letterSpacing: -1, ...style }}>{children}</div>;

/** A small label used in UI mockups. */
export const Pill: React.FC<{ children: React.ReactNode; bg: string; color: string; style?: React.CSSProperties }> = ({ children, bg, color, style }) => (
  <span
    style={{
      display: "inline-block",
      background: bg,
      color,
      borderRadius: 999,
      padding: "6px 16px",
      fontFamily: FONT.body,
      fontWeight: 700,
      fontSize: 22,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </span>
);

export const Scene: React.FC<{ children: React.ReactNode; dark?: boolean; tint?: string }> = ({ children, dark, tint }) => (
  <AbsoluteFill>
    <Backdrop dark={dark} tint={tint} />
    <AbsoluteFill style={{ padding: `96px ${PAD}px` }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);

export const SyntheticNote: React.FC<{ dark?: boolean }> = ({ dark }) => (
  <div
    style={{
      position: "absolute",
      right: PAD,
      bottom: 56,
      fontFamily: FONT.body,
      fontSize: 20,
      color: dark ? "#8FA3AB" : "#8C969A",
    }}
  >
    Synthetic role-play data · AI voices
  </div>
);
