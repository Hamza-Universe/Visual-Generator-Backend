import { describe, expect, it } from 'vitest';
import {
  buildRenderTempPaths,
  canTransitionRenderStatus,
  classifyRenderError,
  decideRenderFailure,
  defaultRenderJobOptions,
  findDuplicateSceneRender,
  isTerminalRenderStatus,
  mapSceneRenderProgress,
  normalizeClientKey,
  normalizeRenderProgress,
  RENDER_COMPLETED_RETENTION,
  RENDER_FAILED_RETENTION,
  RENDER_QUEUE_NAME,
  RENDER_TEMP_DIR_NAME,
  DEFAULT_RENDER_ATTEMPTS,
  DEFAULT_RENDER_BACKOFF_MS,
  DEFAULT_RENDER_CONCURRENCY,
  DEFAULT_RENDER_TIMEOUT_MS,
  resolveRenderStart,
  resolveRetryDecision,
} from '../src/index.js';

describe('render status model', () => {
  it('allows only forward lifecycle transitions', () => {
    expect(canTransitionRenderStatus('queued', 'running')).toBe(true);
    expect(canTransitionRenderStatus('running', 'done')).toBe(true);
    expect(canTransitionRenderStatus('queued', 'cancelled')).toBe(true);
    expect(canTransitionRenderStatus('running', 'failed')).toBe(true);
    expect(canTransitionRenderStatus('running', 'cancelled')).toBe(true);
    expect(canTransitionRenderStatus('queued', 'failed')).toBe(true);
  });

  it('forbids nonsensical transitions out of terminal states', () => {
    for (const terminal of ['done', 'failed', 'cancelled']) {
      expect(canTransitionRenderStatus(terminal, 'running')).toBe(false);
      expect(canTransitionRenderStatus(terminal, 'queued')).toBe(false);
      expect(canTransitionRenderStatus('running', terminal)).toBe(true);
    }
    expect(canTransitionRenderStatus('done', 'failed')).toBe(false);
    expect(canTransitionRenderStatus('failed', 'cancelled')).toBe(false);
    expect(canTransitionRenderStatus('cancelled', 'done')).toBe(false);
    expect(canTransitionRenderStatus('done', 'nope')).toBe(false);
    expect(canTransitionRenderStatus('queued', 'done')).toBe(false);
    // Re-asserting the current state is a harmless no-op, not a transition.
    expect(canTransitionRenderStatus('done', 'done')).toBe(true);
  });

  it('identifies terminal states', () => {
    expect(isTerminalRenderStatus('done')).toBe(true);
    expect(isTerminalRenderStatus('failed')).toBe(true);
    expect(isTerminalRenderStatus('cancelled')).toBe(true);
    expect(isTerminalRenderStatus('queued')).toBe(false);
    expect(isTerminalRenderStatus('running')).toBe(false);
  });
});

describe('render progress', () => {
  it('normalizes to integer 0–100', () => {
    expect(normalizeRenderProgress(45.6)).toBe(46);
    expect(normalizeRenderProgress(-5)).toBe(0);
    expect(normalizeRenderProgress(101)).toBe(100);
    expect(normalizeRenderProgress(Number.NaN)).toBe(0);
    expect(normalizeRenderProgress('50')).toBe(0);
  });

  it('maps encode progress onto stated lifecycle milestones', () => {
    // Bundle/snapshot ready starts at 5; encode maps into 5–95; done is 100.
    expect(mapSceneRenderProgress(0)).toBe(5);
    expect(mapSceneRenderProgress(50)).toBe(50);
    expect(mapSceneRenderProgress(100)).toBe(100);
    const values = [0, 10, 50, 90, 99].map(mapSceneRenderProgress);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(Math.max(...values)).toBeLessThan(100);
  });
});

describe('duplicate protection', () => {
  const rows = [
    { id: 'a', sceneId: 's1', clientKey: 'k1', status: 'running' },
    { id: 'b', sceneId: 's1', clientKey: 'k1', status: 'done' },
    { id: 'c', sceneId: 's2', clientKey: 'k1', status: 'queued' },
  ];

  it('returns the in-flight render for a repeated key', () => {
    expect(findDuplicateSceneRender(rows, 's1', 'k1')?.id).toBe('a');
  });

  it('allows new renders without a key and for other scenes', () => {
    expect(findDuplicateSceneRender(rows, 's1', null)).toBeUndefined();
    expect(findDuplicateSceneRender(rows, 's1', 'k2')).toBeUndefined();
    expect(findDuplicateSceneRender(rows, 's2', 'k1')?.id).toBe('c');
  });

  it('normalizes client keys (blank means no dedupe)', () => {
    expect(normalizeClientKey('  abc  ')).toBe('abc');
    expect(normalizeClientKey('')).toBeNull();
    expect(normalizeClientKey('   ')).toBeNull();
    expect(normalizeClientKey(undefined)).toBeNull();
    expect(normalizeClientKey(42)).toBeNull();
  });
});

describe('worker lifecycle decisions', () => {
  it('aborts before rendering when already cancelled', () => {
    expect(resolveRenderStart('cancelled')).toEqual({ terminal: true, status: 'cancelled' });
    expect(resolveRenderStart('queued')).toEqual({ terminal: false });
    expect(resolveRenderStart('running')).toEqual({ terminal: false });
  });

  it('keeps cancellation cancelled and failures failed with messages', () => {
    expect(decideRenderFailure(new Error('boom'), 'running', false)).toEqual({
      status: 'failed',
      error: 'boom',
    });
    expect(decideRenderFailure(new Error('x'), 'cancelled', false)).toEqual({
      status: 'cancelled',
      error: null,
    });
    expect(decideRenderFailure(new Error('x'), 'running', true)).toEqual({
      status: 'cancelled',
      error: null,
    });
    expect(decideRenderFailure('string failure', 'running', false)).toEqual({
      status: 'failed',
      error: 'Render failed',
    });
  });
});

describe('operational policy (Stage 3H)', () => {
  it('exposes safe shared defaults', () => {
    expect(RENDER_QUEUE_NAME).toBe('render');
    expect(DEFAULT_RENDER_CONCURRENCY).toBe(1);
    expect(DEFAULT_RENDER_ATTEMPTS).toBe(2);
    expect(DEFAULT_RENDER_BACKOFF_MS).toBe(5000);
    expect(DEFAULT_RENDER_TIMEOUT_MS).toBe(600000);
    expect(RENDER_COMPLETED_RETENTION).toBe(100);
    expect(RENDER_FAILED_RETENTION).toBe(100);
  });

  it('builds centralized BullMQ job options', () => {
    expect(defaultRenderJobOptions()).toEqual({
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    expect(defaultRenderJobOptions({ attempts: 3, backoffMs: 1000 }).attempts).toBe(3);
    expect(defaultRenderJobOptions({ attempts: 0 }).attempts).toBe(2);
  });

  it('classifies failures for retry decisions', () => {
    expect(classifyRenderError(new Error('Render was cancelled'))).toBe('retryable');
    const cancelled = new Error('Render was cancelled');
    cancelled.name = 'RenderCancelledError';
    expect(classifyRenderError(cancelled)).toBe('cancelled');
    const zod = new Error('bad');
    zod.name = 'ZodError';
    expect(classifyRenderError(zod)).toBe('non-retryable');
    expect(classifyRenderError(new Error('Invalid SceneDocument render snapshot: x'))).toBe(
      'non-retryable',
    );
    expect(classifyRenderError(new Error('No registry component found for x'))).toBe(
      'non-retryable',
    );
    expect(classifyRenderError(new Error('Referenced asset x is missing or not owned'))).toBe(
      'non-retryable',
    );
    // Timeouts are explicitly retryable (usually load-dependent).
    expect(classifyRenderError(new Error('Render timed out after 600000ms'))).toBe('retryable');
    // Browser/ffmpeg/storage/DB blips are transient.
    expect(classifyRenderError(new Error('browser closed unexpectedly'))).toBe('retryable');
    expect(classifyRenderError(new Error('ECONNRESET'))).toBe('retryable');
  });

  it('retries transient failures until attempts run out, never cancelled rows', () => {
    expect(
      resolveRetryDecision({ classification: 'retryable', attemptsMade: 0, maxAttempts: 2 }),
    ).toBe('retry');
    expect(
      resolveRetryDecision({ classification: 'retryable', attemptsMade: 1, maxAttempts: 2 }),
    ).toBe('fail');
    expect(
      resolveRetryDecision({ classification: 'non-retryable', attemptsMade: 0, maxAttempts: 3 }),
    ).toBe('fail');
    expect(
      resolveRetryDecision({ classification: 'cancelled', attemptsMade: 0, maxAttempts: 3 }),
    ).toBe('cancelled');
    // A late cancellation wins over any other outcome.
    expect(
      resolveRetryDecision({
        classification: 'retryable',
        attemptsMade: 0,
        maxAttempts: 3,
        rowCancelled: true,
      }),
    ).toBe('cancelled');
  });

  it('builds isolated temp paths under a sweepable directory', () => {
    const paths = buildRenderTempPaths('./storage', 'abc123');
    expect(paths.outputPath).toBe(`./storage/${RENDER_TEMP_DIR_NAME}/abc123.mp4`);
    expect(paths.publicDir).toBe(`./storage/${RENDER_TEMP_DIR_NAME}/abc123.mp4.public`);
    // Distinct attempts never share a temp file (no output confusion).
    expect(buildRenderTempPaths('./storage', 'other').outputPath).not.toBe(paths.outputPath);
  });
});
