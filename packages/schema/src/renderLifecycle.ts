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

/* ------------------------------------------------------------------------ */
/* Operational policy (Stage 3H): concurrency, retries, timeouts, cleanup.  */
/* Shared by the API producer and the worker consumer so both sides agree.   */
/* ------------------------------------------------------------------------ */

/** BullMQ queue carrying render jobs. Single queue; no sharding. */
export const RENDER_QUEUE_NAME = 'render';

/**
 * Safe operational defaults. Rendering is CPU/memory/browser intensive, so
 * concurrency starts at 1; retries stay low with exponential backoff; the
 * timeout bounds the longest expected production render with headroom.
 */
export const DEFAULT_RENDER_CONCURRENCY = 1;
export const DEFAULT_RENDER_ATTEMPTS = 2;
export const DEFAULT_RENDER_BACKOFF_MS = 5000;
export const DEFAULT_RENDER_TIMEOUT_MS = 600000;
export const RENDER_COMPLETED_RETENTION = 100;
export const RENDER_FAILED_RETENTION = 100;

export interface RenderJobOptionsInput {
  attempts?: number;
  backoffMs?: number;
}

const positiveIntOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

/**
 * Centralized BullMQ job options for render jobs. Priority-ready: BullMQ
 * accepts a `priority` per `queue.add` call, so future scheduling needs no
 * queue redesign — only a producer-side option.
 */
export const defaultRenderJobOptions = (input: RenderJobOptionsInput = {}): {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: number;
  removeOnFail: number;
} => ({
  attempts: positiveIntOr(input.attempts, DEFAULT_RENDER_ATTEMPTS),
  backoff: {
    type: 'exponential',
    delay: positiveIntOr(input.backoffMs, DEFAULT_RENDER_BACKOFF_MS),
  },
  removeOnComplete: RENDER_COMPLETED_RETENTION,
  removeOnFail: RENDER_FAILED_RETENTION,
});

export type RenderFailureClass = 'retryable' | 'non-retryable' | 'cancelled';

const NON_RETRYABLE_PATTERNS = [
  /invalid/i,
  /not found/i,
  /no owner/i,
  /no registry component/i,
  /missing/i,
  /unknown/i,
  /must reference/i,
  /forbidden/i,
  /unauthorized/i,
  /bad input/i,
  /terminal/i,
];

/**
 * Failure classification driving retry decisions.
 *
 * - cancelled: cooperative shutdown signal — never retried, never failed.
 * - non-retryable: deterministic validation/ownership failures (incl.
 *   Zod errors) that cannot succeed on another attempt.
 * - retryable: everything else — browser/ffmpeg crashes, timeouts (usually
 *   load-dependent), storage/DB blips. Timeouts are explicitly retryable.
 */
export const classifyRenderError = (error: unknown): RenderFailureClass => {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (name === 'RenderCancelledError') return 'cancelled';
  if (name === 'ZodError') return 'non-retryable';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timed?\s?out/i.test(message)) return 'retryable';
  if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'non-retryable';
  }
  return 'retryable';
};

export type RetryDecision = 'retry' | 'fail' | 'cancelled';

/**
 * Pure retry decision: cancelled never retries; non-retryable fails fast;
 * retryable failures retry until attempts run out. Late cancellation (row
 * already `cancelled`) wins over every other outcome.
 */
export const resolveRetryDecision = (input: {
  classification: RenderFailureClass;
  attemptsMade: number;
  maxAttempts: number;
  rowCancelled?: boolean;
}): RetryDecision => {
  if (input.classification === 'cancelled' || input.rowCancelled) return 'cancelled';
  if (input.classification === 'non-retryable') return 'fail';
  const made = Number.isInteger(input.attemptsMade) && input.attemptsMade >= 0
    ? input.attemptsMade
    : 0;
  const max = Number.isInteger(input.maxAttempts) && input.maxAttempts >= 1
    ? input.maxAttempts
    : 1;
  return made + 1 >= max ? 'fail' : 'retry';
};

/** In-process temp layout: crash orphans are identifiable and sweepable. */
export const RENDER_TEMP_DIR_NAME = '.render-tmp';

export const buildRenderTempPaths = (
  storageDir: string,
  tempId: string,
): { outputPath: string; publicDir: string } => {
  const normalized = storageDir.endsWith('/') ? storageDir.slice(0, -1) : storageDir;
  const outputPath = `${normalized}/${RENDER_TEMP_DIR_NAME}/${tempId}.mp4`;
  return { outputPath, publicDir: `${outputPath}.public` };
};
