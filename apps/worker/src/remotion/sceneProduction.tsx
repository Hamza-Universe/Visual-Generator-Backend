import { useCurrentFrame } from 'remotion';
import type { ReactNode } from 'react';
import { SceneComposition, type SceneCompositionProps } from './scene.js';

/**
 * Production SceneDocument composition (Stage 3E).
 *
 * Same frame-aware architecture as the Stage 3B preview entry
 * (`SceneFrameComposition`): Remotion's current frame is the source of
 * truth, `SceneComposition` runs the shared `renderSceneAtFrame(document,
 * frame)` and paints the shared render tree with the registered component
 * renderers. Registered separately (`SceneDocumentProduction`) so the
 * production render path has a stable, explicit target.
 *
 * Input contract: an immutable snapshot (`document` + `definitions`).
 * No database access, no editor state, no mutation — the evaluator already
 * returns evaluated copies per frame.
 */
export const SceneProductionComposition = (
  props: Omit<SceneCompositionProps, 'frame'>,
): ReactNode => {
  const frame = useCurrentFrame();
  return <SceneComposition {...props} frame={frame} />;
};

export type { SceneCompositionProps };
