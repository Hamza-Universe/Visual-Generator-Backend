/**
 * Production render job lifecycle (Stage 3F).
 *
 * Pure, dependency-free rules shared by the API (record creation,
 * transitions, duplicate guard) and the worker (outcome decisions).
 *
 * Status vocabulary follows the existing project convention
 * (`queued / running / done / failed`, as stored in `renders.status` and
 * consumed by the frontend/MCP/OpenAPI contract), plus `cancelled`:
 *
 *   queued → running → done
 *   queued/running → failed | cancelled
 *
 * Terminal states (`done`, `failed`, `cancelled`) never transition again.
 * Here `done` ≡ completed and `running` ≡ processing in task terminology.
 */

export const RENDER_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
] as const;

export type RenderStatus = (typeof RENDER_STATUSES)[number];

export const TERMINAL_RENDER_STATUSES: readonly RenderStatus[] = [
  'done',
  'failed',
  'cancelled',
] as const;

export const isRenderStatus = (value: unknown): value is RenderStatus =>
  typeof value === 'string' &&
  (RENDER_STATUSES as readonly string[]).includes(value);

export const isTerminalRenderStatus = (status: unknown): boolean =>
  typeof status === 'string' &&
  (TERMINAL_RENDER_STATUSES as readonly string[]).includes(status);

/**
 * Deterministic transition guard. Only forward lifecycle moves are allowed;
 * terminal records are immutable.
 */
export const canTransitionRenderStatus = (
  from: unknown,
  to: unknown,
): boolean => {
  if (!isRenderStatus(from) || !isRenderStatus(to)) return false;
  if (from === to) return true;
  switch (from) {
    case 'queued':
      return to === 'running' || to === 'failed' || to === 'cancelled';
    case 'running':
      return to === 'done' || to === 'failed' || to === 'cancelled';
    default:
      return false;
  }
};

/** Canonical progress range is 0–100 (integer). Invalid input normalizes. */
export const normalizeRenderProgress = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
};

/**
 * Milestone mapping for SceneDocument production renders.
 *
 * Remotion's own progress covers the encode; this maps it onto lifecycle
 * milestones with a stated basis — no invented precision:
 *   snapshot + assets resolved → 5 (bundle prepared)
 *   renderMedia progress p      → 5 + p·0.9  (rendering, 5–95)
 *   output stored               → 100 (completed)
 */
export const SCENE_RENDER_BASE_PROGRESS = 5;

export const mapSceneRenderProgress = (remotionProgress: unknown): number => {
  const p = normalizeRenderProgress(remotionProgress);
  if (p >= 100) return 100;
  return normalizeRenderProgress(
    SCENE_RENDER_BASE_PROGRESS + (p * (95 - SCENE_RENDER_BASE_PROGRESS)) / 100,
  );
};

export interface RenderRecordLike {
  id: string;
  sceneId?: string | null;
  clientKey?: string | null;
  status: string;
}

/**
 * Smallest duplicate guard: a non-terminal render for the same scene with
 * the same client-provided key means "already requested" — return it instead
 * of creating another row. Without a key, every request is intentional and
 * always creates a new render.
 */
export const findDuplicateSceneRender = <T extends RenderRecordLike>(
  records: readonly T[],
  sceneId: string,
  clientKey: string | null | undefined,
): T | undefined => {
  if (!clientKey) return undefined;
  return records.find(
    (record) =>
      record.sceneId === sceneId &&
      record.clientKey === clientKey &&
      !isTerminalRenderStatus(record.status),
  );
};

/** Normalize an optional client key (empty/blank → null = no dedupe). */
export const normalizeClientKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, 128);
};

export type RenderJobOutcome =
  | { readonly terminal: false }
  | { readonly terminal: true; readonly status: 'cancelled' };

/**
 * Worker entry guard: a record already marked `cancelled` must not render.
 * Checked after loading the row and before any render work begins.
 */
export const resolveRenderStart = (status: unknown): RenderJobOutcome =>
  status === 'cancelled'
    ? { terminal: true, status: 'cancelled' }
    : { terminal: false };

export interface RenderFailureDecision {
  readonly status: 'failed' | 'cancelled';
  /** Error message to persist, or null when cancellation carries no error. */
  readonly error: string | null;
}

/**
 * Worker failure mapping: cancellation (explicit signal or a row already
 * marked cancelled) stays `cancelled` with no error; everything else is
 * `failed` with a useful message. Never leaves a record stuck in `running`.
 */
export const decideRenderFailure = (
  error: unknown,
  currentStatus: unknown,
  cancelledSignal = false,
): RenderFailureDecision => {
  if (cancelledSignal || currentStatus === 'cancelled') {
    return { status: 'cancelled', error: null };
  }
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : 'Render failed',
  };
};
