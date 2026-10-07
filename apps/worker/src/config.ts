import { z } from 'zod';
import {
  DEFAULT_RENDER_CONCURRENCY,
  DEFAULT_RENDER_TIMEOUT_MS,
} from '@app/schema';

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STORAGE_DIR: z.string().min(1),
  /**
   * Stage 3H operational knobs (all optional, safe defaults).
   *
   * RENDER_WORKER_CONCURRENCY: concurrent renders per worker process.
   * Defaults to 1 — Remotion renders are CPU/memory/browser intensive, so
   * concurrency is opt-in, never assumed. Raise only on machines sized
   * for parallel browser encodes.
   *
   * RENDER_TIMEOUT_MS: maximum wall-clock time per render attempt. Bounds
   * the longest expected production render with headroom; enforcement
   * aborts the encode, fails the record (retryable), and cleans up.
   *
   * Attempts/backoff are producer concerns (BullMQ job options set by the
   * API at enqueue time); the worker observes them from `job.opts`.
   */
  RENDER_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(
    DEFAULT_RENDER_CONCURRENCY,
  ),
  RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(
    DEFAULT_RENDER_TIMEOUT_MS,
  ),
});
export const loadConfig = () => {
  const result = Schema.safeParse(process.env);
  if (!result.success) {
    console.error(
      'Invalid worker configuration',
      result.error.flatten().fieldErrors,
    );
    process.exit(1);
  }
  return result.data;
};
