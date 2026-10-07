import { z } from 'zod';
import { SceneDocumentSchema } from './document.js';

/**
 * Production SceneDocument render snapshot (Stage 3E).
 *
 * The worker render queue carries only `{ renderId }`; the immutable render
 * input lives in `renders.specSnapshot`. Legacy rows hold a `VideoSpec`.
 * SceneDocument rows hold this envelope, distinguished by the explicit
 * `source: 'scene-document'` marker — no DB migration, no guessing from
 * shape, legacy rows untouched.
 *
 * - `document`: complete SceneDocument snapshot (timeline, components,
 *   groups). Timeline defaults apply when absent (30fps / 300 frames).
 * - `definitions`: componentDefinitionId → renderer name, resolved once at
 *   enqueue time so production rendering never queries per frame.
 */
export const SCENE_DOCUMENT_SNAPSHOT_SOURCE = 'scene-document' as const;

export const SceneRenderSnapshotSchema = z.object({
  source: z.literal(SCENE_DOCUMENT_SNAPSHOT_SOURCE),
  document: SceneDocumentSchema,
  definitions: z.record(z.string().uuid(), z.string().min(1)),
});

export type SceneRenderSnapshot = z.infer<typeof SceneRenderSnapshotSchema>;

/** True only for the explicit scene-document envelope (never throws). */
export const isSceneDocumentSnapshot = (value: unknown): value is SceneRenderSnapshot => {
  if (!value || typeof value !== 'object') return false;
  return (value as { source?: unknown }).source === SCENE_DOCUMENT_SNAPSHOT_SOURCE;
};

/** Parse + validate a snapshot, throwing a plain Error with a clear message. */
export const parseSceneRenderSnapshot = (value: unknown): SceneRenderSnapshot => {
  const parsed = SceneRenderSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid SceneDocument render snapshot: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
};
