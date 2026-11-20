import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Hook } from "./scenes/Hook";
import { Problem } from "./scenes/Problem";
import { WhyLate } from "./scenes/WhyLate";
import { Solution } from "./scenes/Solution";
import { Intake } from "./scenes/Intake";
import { Forms } from "./scenes/Forms";
import { Handoff } from "./scenes/Handoff";
import { Different } from "./scenes/Different";
import { Business } from "./scenes/Business";
import { Close } from "./scenes/Close";
import type { SceneId } from "./script";
import { LEAD, ORDER, sceneFrames, TRANSITION, voice, VO } from "./timing";
import { C } from "./theme";

const SCENES: Record<SceneId, React.FC> = {
  hook: Hook,
  problem: Problem,
  "why-late": WhyLate,
  solution: Solution,
  intake: Intake,
  forms: Forms,
  handoff: Handoff,
  different: Different,
  business: Business,
  close: Close,
};

/** The "thread": an orange line along the bottom edge that grows with the video. */
const Thread: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        height: 8,
        width: `${(frame / (durationInFrames - 1)) * 100}%`,
        background: `linear-gradient(90deg, ${C.teal}, ${C.orange})`,
      }}
    />
  );
};

const Music: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  if (!VO.music) return null;
  return (
    <Audio
      src={staticFile(VO.music)}
      volume={(f) =>
        interpolate(f, [0, 45, durationInFrames - 90, durationInFrames - 1], [0, 0.09, 0.09, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
  );
};

export const CareThreadJury: React.FC = () => (
  <AbsoluteFill style={{ background: C.cream }}>
    <TransitionSeries>
      {ORDER.flatMap((id, i) => {
        const Comp = SCENES[id];
        const items = [
          <TransitionSeries.Sequence key={id} durationInFrames={sceneFrames(id)}>
            <Comp />
            <Sequence from={LEAD} layout="none">
              <Audio src={staticFile(voice(id).file)} />
            </Sequence>
          </TransitionSeries.Sequence>,
        ];
        if (i < ORDER.length - 1)
          items.push(<TransitionSeries.Transition key={`${id}-t`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />);
        return items;
      })}
    </TransitionSeries>
    <Music />
    <Thread />
  </AbsoluteFill>
);
