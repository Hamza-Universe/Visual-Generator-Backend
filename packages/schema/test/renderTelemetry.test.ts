import { describe, expect, it, vi } from 'vitest';
import {
  RENDER_SOURCE_SCENE_DOCUMENT,
  RENDER_SOURCE_VIDEO_SPEC,
  buildRenderTelemetryEvent,
  emitRenderTelemetry,
} from '../src/index.js';

describe('render telemetry', () => {
  it('distinguishes scene-document from video-spec sources', () => {
    expect(RENDER_SOURCE_SCENE_DOCUMENT).toBe('scene-document');
    expect(RENDER_SOURCE_VIDEO_SPEC).toBe('video-spec');
    const event = buildRenderTelemetryEvent({
      event: 'requested',
      source: 'video-spec',
      renderId: 'r1',
      projectId: 'p1',
    });
    expect(event).toEqual({
      telemetry: 'render',
      event: 'requested',
      source: 'video-spec',
      renderId: 'r1',
      projectId: 'p1',
      sceneId: null,
      timestamp: expect.any(String),
    });
  });

  it('carries project/render/scene identity with an explicit timestamp', () => {
    const event = buildRenderTelemetryEvent({
      event: 'succeeded',
      source: 'scene-document',
      renderId: 'r2',
      projectId: 'p2',
      sceneId: 's2',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(event.sceneId).toBe('s2');
    expect(event.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('emits through the host sink without payload data', () => {
    const sink = vi.fn();
    emitRenderTelemetry(
      sink,
      buildRenderTelemetryEvent({
        event: 'failed',
        source: 'video-spec',
        renderId: 'r3',
        projectId: 'p3',
      }),
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sink.mock.calls[0][0])).not.toContain('specSnapshot');
  });

  it('never throws, even when the sink fails', () => {
    expect(() =>
      emitRenderTelemetry(
        () => {
          throw new Error('log down');
        },
        buildRenderTelemetryEvent({
          event: 'requested',
          source: 'scene-document',
          renderId: 'r4',
          projectId: 'p4',
          sceneId: 's4',
        }),
      ),
    ).not.toThrow();
  });
});
