import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AnimationSchema,
  SceneDocumentSchema,
  TimelineSchema,
  TimingSchema,
  isFrameVisibleAt,
  resolveSceneTimeline,
  resolveTimingFrames,
} from '../src/document.js';

describe('Stage 3A timeline schema', () => {
  it('defaults SceneDocument timeline to 30fps / 300 frames', () => {
    const parsed = SceneDocumentSchema.parse({
      id: randomUUID(),
      projectId: randomUUID(),
      name: 'Scene',
    });
    expect(parsed.timeline).toEqual({ fps: 30, durationFrames: 300 });
  });

  it('accepts explicit timeline metadata with frames as canonical unit', () => {
    expect(TimelineSchema.parse({ fps: 30, durationFrames: 300 })).toEqual({
      fps: 30,
      durationFrames: 300,
    });
  });

  it('keeps legacy timing parsing unchanged while accepting frame fields', () => {
    expect(TimingSchema.parse({ start: 0, duration: 2 })).toMatchObject({ start: 0, duration: 2 });
    expect(
      TimingSchema.parse({ start: 0, duration: 2, startFrame: 30, durationFrames: 60 }),
    ).toMatchObject({ startFrame: 30, durationFrames: 60 });
  });

  it('keeps legacy animation parsing unchanged while accepting tracks', () => {
    expect(AnimationSchema.parse({ enter: [], exit: [], keyframes: [] })).toMatchObject({
      enter: [],
      exit: [],
      keyframes: [],
    });
    const parsed = AnimationSchema.parse({
      enter: [],
      exit: [],
      keyframes: [],
      tracks: [
        { property: 'position.x', keyframes: [{ frame: 0, value: 100 }, { frame: 30, value: 500 }] },
      ],
    });
    expect(parsed.tracks).toHaveLength(1);
  });

  it('resolves frame timing with inclusive/exclusive boundaries', () => {
    expect(resolveTimingFrames({ startFrame: 30, durationFrames: 60 }, 30)).toEqual({
      startFrame: 30,
      durationFrames: 60,
      endFrame: 90,
    });
    expect(isFrameVisibleAt({ startFrame: 30, durationFrames: 60 }, 29, 30)).toBe(false);
    expect(isFrameVisibleAt({ startFrame: 30, durationFrames: 60 }, 30, 30)).toBe(true);
    expect(isFrameVisibleAt({ startFrame: 30, durationFrames: 60 }, 89, 30)).toBe(true);
    expect(isFrameVisibleAt({ startFrame: 30, durationFrames: 60 }, 90, 30)).toBe(false);
  });

  it('resolves scene timeline from legacy duration when needed', () => {
    expect(resolveSceneTimeline({ duration: 10 })).toEqual({ fps: 30, durationFrames: 300 });
  });
});
