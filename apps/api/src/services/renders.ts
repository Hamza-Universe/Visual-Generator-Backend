import { isSceneDocumentSnapshot } from '@app/schema';

export interface RenderStatusPayload {
  id: string;
  projectId: string;
  sceneId: string | null;
  status: string;
  progress: number;
  outputAssetId: string | null;
  error: string | null;
  source: 'scene-document' | 'video-spec';
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type RenderRow = {
  id: string;
  projectId: string;
  sceneId: string | null;
  status: string;
  progress: number;
  specSnapshot: unknown;
  outputAssetId: string | null;
  error: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const iso = (value: Date | string | null): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
};

/**
 * Lean polling payload for render status (Stage 3F). Omits the heavyweight
 * snapshot/document so status polling stays cheap; derives the explicit
 * render source the same way the worker routes jobs.
 */
export const toRenderStatusPayload = (render: RenderRow): RenderStatusPayload => ({
  id: render.id,
  projectId: render.projectId,
  sceneId: render.sceneId,
  status: render.status,
  progress: render.progress,
  outputAssetId: render.outputAssetId,
  error: render.error,
  source: isSceneDocumentSnapshot(render.specSnapshot) ? 'scene-document' : 'video-spec',
  startedAt: iso(render.startedAt),
  completedAt: iso(render.completedAt),
  createdAt: iso(render.createdAt) as string,
  updatedAt: iso(render.updatedAt) as string,
});
