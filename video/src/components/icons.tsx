import React from "react";
import { C } from "../theme";

type P = { size?: number; color?: string; style?: React.CSSProperties };

const svg = (size: number, style: React.CSSProperties | undefined, children: React.ReactNode, vb = "0 0 24 24") => (
  <svg width={size} height={size} viewBox={vb} style={style} fill="none" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const IconCheck: React.FC<P> = ({ size = 28, color = C.green, style }) =>
  svg(size, style, <path d="M5 12.5l4.5 4.5L19 7.5" stroke={color} strokeWidth={3} />);

export const IconX: React.FC<P> = ({ size = 28, color = C.muted, style }) =>
  svg(size, style, <path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth={2.6} />);

export const IconPhone: React.FC<P> = ({ size = 40, color = C.navy, style }) =>
  svg(
    size,
    style,
    <path
      d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"
      stroke={color}
      strokeWidth={2}
    />,
  );

export const IconDoc: React.FC<P> = ({ size = 40, color = C.navy, style }) =>
  svg(
    size,
    style,
    <>
      <path d="M6 3h8l4 4v14H6z" stroke={color} strokeWidth={2} />
      <path d="M14 3v4h4M9 12h6M9 16h6" stroke={color} strokeWidth={2} />
    </>,
  );

export const IconClock: React.FC<P> = ({ size = 40, color = C.navy, style }) =>
  svg(
    size,
    style,
    <>
      <circle cx={12} cy={12} r={9} stroke={color} strokeWidth={2} />
      <path d="M12 7v5l3 2" stroke={color} strokeWidth={2} />
    </>,
  );

export const IconPeople: React.FC<P> = ({ size = 40, color = C.navy, style }) =>
  svg(
    size,
    style,
    <>
      <circle cx={9} cy={8} r={3.2} stroke={color} strokeWidth={2} />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke={color} strokeWidth={2} />
      <circle cx={17} cy={9} r={2.5} stroke={color} strokeWidth={2} />
      <path d="M16 14.2c2.8.3 5 2.6 5 5.8" stroke={color} strokeWidth={2} />
    </>,
  );

export const IconPlay: React.FC<P> = ({ size = 22, color = C.teal, style }) =>
  svg(size, style, <path d="M8 5l11 7-11 7z" fill={color} />);

export const IconPin: React.FC<P> = ({ size = 30, color = C.rust, style }) =>
  svg(
    size,
    style,
    <>
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0112 2.5a7 7 0 017 7C19 14.8 12 21 12 21z" stroke={color} strokeWidth={2} />
      <circle cx={12} cy={9.5} r={2.5} stroke={color} strokeWidth={2} />
    </>,
  );

export const IconSend: React.FC<P> = ({ size = 30, color = C.card, style }) =>
  svg(size, style, <path d="M3 11l18-8-8 18-2-8z" stroke={color} strokeWidth={2} />);

export const IconFlag: React.FC<P> = ({ size = 26, color = C.red, style }) =>
  svg(
    size,
    style,
    <>
      <path d="M5 21V4" stroke={color} strokeWidth={2.4} />
      <path d="M5 4h11l-2 4 2 4H5" fill={color} stroke={color} strokeWidth={1.5} />
    </>,
  );

/** Simple, friendly figure. */
export const Figure: React.FC<{ x: number; y: number; h: number; color: string; flip?: boolean }> = ({ x, y, h, color, flip }) => {
  const r = h * 0.17;
  return (
    <g transform={`translate(${x} ${y}) ${flip ? "scale(-1 1)" : ""}`}>
      <circle cx={0} cy={-h + r} r={r} fill={color} />
      <path
        d={`M ${-h * 0.24} 0 Q ${-h * 0.26} ${-h * 0.62} 0 ${-h * 0.64} Q ${h * 0.26} ${-h * 0.62} ${h * 0.24} 0 Z`}
        fill={color}
      />
    </g>
  );
};
