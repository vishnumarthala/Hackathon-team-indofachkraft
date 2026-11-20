import vo from "./voiceover.json";
import { SCRIPT, type SceneId } from "./script";

export const FPS = 30;
export const LEAD = 15; // frames before narration starts in a scene
export const TAIL = 21; // frames after narration ends
export const TRANSITION = 15; // cross-fade overlap between scenes
export const INTAKE_GAP = 10; // pause between intake narration and the call excerpt
export const END_HOLD = 54; // logo hold after the last line

type Manifest = {
  engine: string;
  voice: string;
  scenes: { id: string; file: string; duration: number }[];
  intake: { file: string; duration: number };
  music: string | null;
};
export const VO = vo as Manifest;

const f = (sec: number) => Math.round(sec * FPS);

export function voice(id: SceneId) {
  const s = VO.scenes.find((x) => x.id === id);
  if (!s) throw new Error(`No voiceover for scene ${id}; run npm run voice`);
  return { file: s.file, frames: f(s.duration) };
}

export const INTAKE_FRAMES = f(VO.intake.duration);
/** Frame (within the intake scene) where the call excerpt starts. */
export const intakeStart = () => LEAD + voice("intake").frames + INTAKE_GAP;

export function sceneFrames(id: SceneId): number {
  let n = LEAD + voice(id).frames + TAIL;
  if (id === "intake") n += INTAKE_GAP + INTAKE_FRAMES;
  if (id === "close") n += END_HOLD;
  return n;
}

/**
 * Approximate frame (within a scene) where `phrase` is spoken, by its character position in the
 * narration. Good enough to land visuals on the right sentence with any voice.
 */
export function cue(id: SceneId, phrase: string, offset = 0): number {
  const text = SCRIPT.find((s) => s.id === id)!.voice;
  const i = text.indexOf(phrase);
  if (i < 0) throw new Error(`Cue "${phrase}" not found in scene ${id}`);
  return LEAD + Math.round((voice(id).frames * i) / text.length) + offset;
}

export const ORDER: SceneId[] = SCRIPT.map((s) => s.id);
export const TOTAL_FRAMES = ORDER.reduce((n, id) => n + sceneFrames(id), 0) - TRANSITION * (ORDER.length - 1);
