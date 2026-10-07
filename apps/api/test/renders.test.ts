import { describe, expect, it } from 'vitest';
import { toRenderStatusPayload } from '../src/services/renders.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'render-1',
  projectId: 'project-1',
  sceneId: 'scene-1',
  status: 'running',
  progress: 45,
  specSnapshot: {
    source: 'scene-document',
    document: { components: [], groups: [] },
    definitions: {},
  },
  outputAssetId: null,
  error: null,
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:01:00.000Z'),
  ...overrides,
});

describe('render status payload', () => {
  it('exposes a lean polling shape with an explicit source', () => {
    const payload = toRenderStatusPayload(row() as never);
    expect(payload).toEqual({
      id: 'render-1',
      projectId: 'project-1',
      sceneId: 'scene-1',
      status: 'running',
      progress: 45,
      outputAssetId: null,
      error: null,
      source: 'scene-document',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    expect('specSnapshot' in payload).toBe(false);
  });

  it('marks legacy snapshots as video-spec source', () => {
    const payload = toRenderStatusPayload(
      row({ sceneId: null, specSnapshot: { version: 1 } }) as never,
    );
    expect(payload.source).toBe('video-spec');
    expect(payload.sceneId).toBeNull();
  });

  it('carries terminal state with output and completion time', () => {
    const payload = toRenderStatusPayload(
      row({
        status: 'done',
        progress: 100,
        outputAssetId: 'asset-1',
        completedAt: new Date('2026-01-01T00:05:00.000Z'),
      }) as never,
    );
    expect(payload.status).toBe('done');
    expect(payload.progress).toBe(100);
    expect(payload.outputAssetId).toBe('asset-1');
    expect(payload.completedAt).toBe('2026-01-01T00:05:00.000Z');
  });
});
