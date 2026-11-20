import React from "react";
import { Composition } from "remotion";
import { CareThreadJury } from "./Video";
import { FPS, TOTAL_FRAMES } from "./timing";
import { H, W } from "./theme";

export const Root: React.FC = () => (
  <Composition id="CareThreadJury" component={CareThreadJury} durationInFrames={TOTAL_FRAMES} fps={FPS} width={W} height={H} />
);
