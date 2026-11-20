import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";

/** CareThread wordmark: a thread that draws itself through a dot. */
export const Logo: React.FC<{ size?: number; delay?: number; dark?: boolean }> = ({ size = 120, delay = 0, dark }) => {
  const frame = useCurrentFrame();
  const draw = interpolate(frame - delay, [0, 30], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const text = interpolate(frame - delay, [10, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ink = dark ? C.cream : C.navy;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.22 }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx={50} cy={50} r={44} fill={dark ? C.navy2 : C.tealLight} />
        <path
          d="M10 62 C 28 30, 44 30, 50 50 S 72 72, 90 38"
          stroke={C.orange}
          strokeWidth={8}
          fill="none"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={draw}
        />
        <circle cx={50} cy={50} r={9} fill={C.teal} opacity={1 - draw} />
      </svg>
      <div style={{ fontFamily: FONT.head, fontWeight: 800, fontSize: size * 0.62, color: ink, letterSpacing: -1, opacity: text }}>
        Care<span style={{ color: C.orange }}>Thread</span>
      </div>
    </div>
  );
};
