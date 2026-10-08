import { useCurrentFrame } from 'remotion';
import type { ReactNode } from 'react';
import { SceneComposition, type SceneCompositionProps } from './scene.js';

/**
 * Frame-aware Remotion entry for a SceneDocument (Stage 3B).
 *
 * Remotion's current frame is the single source of truth — no React state,
 * no timers (`setInterval`/`setTimeout`/`requestAnimationFrame` are banned
 * here). Each render reads `useCurrentFrame()` and delegates to the pure
 * `SceneComposition`, which runs `evaluateSceneAtFrame(document, frame)`
 * and builds the existing render tree. All interpolation authority stays
 * in the Stage 3A evaluator (`@app/render`).
 */
export const SceneFrameComposition = (
  props: Omit<SceneCompositionProps, 'frame'>,
): ReactNode => {
  const frame = useCurrentFrame();
  return <SceneComposition {...props} frame={frame} />;
};

export type { SceneCompositionProps };
