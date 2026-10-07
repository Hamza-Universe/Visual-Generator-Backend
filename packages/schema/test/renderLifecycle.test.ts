import { describe, expect, it } from 'vitest';
import {
  canTransitionRenderStatus,
  decideRenderFailure,
  findDuplicateSceneRender,
  isTerminalRenderStatus,
  mapSceneRenderProgress,
  normalizeClientKey,
  normalizeRenderProgress,
  resolveRenderStart,
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
