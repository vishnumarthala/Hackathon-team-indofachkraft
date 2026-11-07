import { Instrument_Serif, Inter } from "next/font/google";

// Marketing pages only: Inter for UI text, Instrument Serif for display headlines.
const sans = Inter({ subsets: ["latin"], variable: "--font-lp-sans", display: "swap" });
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-lp-display",
  display: "swap",
});

export const fontVars = `${sans.variable} ${display.variable}`;
