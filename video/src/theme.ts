import { loadFont as loadRubik } from "@remotion/google-fonts/Rubik";
import { loadFont as loadNunito } from "@remotion/google-fonts/Nunito";
import { loadFont as loadTelugu } from "@remotion/google-fonts/NotoSansTelugu";

const rubik = loadRubik("normal", { weights: ["500", "700", "800"], subsets: ["latin"] });
const nunito = loadNunito("normal", { weights: ["400", "600", "700", "800"], subsets: ["latin", "latin-ext"] });
const telugu = loadTelugu("normal", { weights: ["400", "600"], subsets: ["telugu"] });

export const FONT = {
  head: rubik.fontFamily,
  body: nunito.fontFamily,
  telugu: `${telugu.fontFamily}, ${nunito.fontFamily}`,
};

// Colours sampled from the pitch deck.
export const C = {
  cream: "#F6F3EC",
  sand: "#EEE9DF",
  card: "#FDFBF7",
  line: "#E3DDD1",
  navy: "#14303B",
  navy2: "#1E3D49",
  orange: "#E07A3F",
  rust: "#B4541F",
  peach: "#F0A46A",
  teal: "#2A7B80",
  tealDark: "#1F6468",
  tealLight: "#E2EFEF",
  ink: "#2B3A40",
  muted: "#66757B",
  green: "#2F8F5B",
  red: "#C2412D",
};

export const W = 1920;
export const H = 1080;
export const PAD = 128;
