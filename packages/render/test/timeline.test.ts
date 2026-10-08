import { describe, expect, it } from 'vitest';
import {
  ANIMATABLE_PROPERTIES,
  DEFAULT_DURATION_FRAMES,
  DEFAULT_FPS,
  buildPaintList,
  buildRenderTree,
  evaluateEasing,
  evaluateSceneAtFrame,
  interpolateKeyframes,
  isFrameVisible,
  normalizeFrame,
  normalizeKeyframes,
  resolveTimeline,
  resolveTimingFrames,
} from '../src/index.js';
import type { TimelineDocument } from '../src/index.js';

const doc = (overrides: Partial<TimelineDocument> = {}): TimelineDocument => ({
  timeline: { fps: 30, durationFrames: 300 },
  components: [],
  groups: [],
  ...overrides,
});

const inst = (overrides: Record<string, unknown> = {}) => ({
  id: `i-${Math.random().toString(36).slice(2)}`,
  props: {},
  position: { x: 0, y: 0 },
  size: { width: 100, height: 100 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 },
  style: { opacity: 1 },
  visible: true,
  zIndex: 0,
  groupId: null,
  ...overrides,
});

describe('timeline metadata', () => {
  it('stores fps and durationFrames', () => {
    expect(resolveTimeline(doc({ timeline: { fps: 30, durationFrames: 300 } }))).toEqual({
      fps: 30,
      durationFrames: 300,
    });
  });

  it('falls back to defaults for invalid timeline data', () => {
    expect(resolveTimeline(doc({ timeline: null, duration: null }))).toEqual({
      fps: DEFAULT_FPS,
      durationFrames: DEFAULT_DURATION_FRAMES,
    });
    expect(
      resolveTimeline(doc({ timeline: { fps: NaN, durationFrames: Infinity } as never })),
    ).toEqual({ fps: DEFAULT_FPS, durationFrames: DEFAULT_DURATION_FRAMES });
    expect(resolveTimeline(doc({ timeline: { fps: -5, durationFrames: -2 } }))).toEqual({
      fps: DEFAULT_FPS,
      durationFrames: DEFAULT_DURATION_FRAMES,
    });
  });

  it('falls back to legacy duration (seconds) when timeline is absent', () => {
    expect(resolveTimeline(doc({ timeline: undefined, duration: 10 }))).toEqual({
      fps: 30,
      durationFrames: 300,
    });
  });
});

describe('timing boundaries', () => {
  const timing = { startFrame: 30, durationFrames: 60 }; // visible 30..89
  it('frame before start → invisible', () => {
    expect(isFrameVisible(timing, 29, 30)).toBe(false);
  });
  it('frame at start → visible', () => {
    expect(isFrameVisible(timing, 30, 30)).toBe(true);
  });
  it('frame during duration → visible', () => {
    expect(isFrameVisible(timing, 45, 30)).toBe(true);
    expect(isFrameVisible(timing, 89, 30)).toBe(true);
  });
  it('frame at end → invisible (exclusive end)', () => {
    expect(isFrameVisible(timing, 90, 30)).toBe(false);
  });

  it('evaluator marks out-of-range instances invisible but keeps them', () => {
    const d = doc({
      components: [inst({ id: 'a', timing })],
    });
    const before = evaluateSceneAtFrame(d, 29);
    expect(before.components).toHaveLength(1);
    expect(before.components[0].id).toBe('a');
    expect(before.components[0].visible).toBe(false);
    expect(evaluateSceneAtFrame(d, 30).components[0].visible).toBe(true);
    expect(evaluateSceneAtFrame(d, 89).components[0].visible).toBe(true);
    expect(evaluateSceneAtFrame(d, 90).components[0].visible).toBe(false);
  });

  it('zero duration is never visible', () => {
    expect(isFrameVisible({ startFrame: 10, durationFrames: 0 }, 10, 30)).toBe(false);
  });

  it('ANDs the stored visible flag with timing', () => {
    const d = doc({
      components: [inst({ id: 'a', visible: false, timing: { startFrame: 0, durationFrames: 300 } })],
    });
    expect(evaluateSceneAtFrame(d, 10).components[0].visible).toBe(false);
  });
});

describe('interpolation', () => {
  const kfs = [
    { frame: 0, value: 100 },
    { frame: 30, value: 500 },
  ];
  it('before first keyframe → first value', () => {
    expect(interpolateKeyframes(kfs, -5)).toBe(100);
  });
  it('exact first keyframe', () => {
    expect(interpolateKeyframes(kfs, 0)).toBe(100);
  });
  it('middle interpolates linearly by default', () => {
    expect(interpolateKeyframes(kfs, 15)).toBeCloseTo(300, 9);
  });
  it('exact final keyframe', () => {
    expect(interpolateKeyframes(kfs, 30)).toBe(500);
  });
  it('after final keyframe → last value', () => {
    expect(interpolateKeyframes(kfs, 999)).toBe(500);
  });
  it('empty tracks → undefined (keep base value)', () => {
    expect(interpolateKeyframes([], 10)).toBeUndefined();
  });
  it('single keyframe → constant', () => {
    expect(interpolateKeyframes([{ frame: 5, value: 42 }], 0)).toBe(42);
    expect(interpolateKeyframes([{ frame: 5, value: 42 }], 100)).toBe(42);
  });
  it('dedupes duplicate frames keeping the last, sorts unsorted input', () => {
    expect(
      interpolateKeyframes(
        [
          { frame: 20, value: 200 },
          { frame: 0, value: 0 },
          { frame: 20, value: 999 },
        ],
        20,
      ),
    ).toBe(999);
    expect(normalizeKeyframes([{ frame: 20, value: 1 }, { frame: 0, value: 0 }]).map((k) => k.frame)).toEqual([0, 20]);
  });
  it('drops invalid keyframes deterministically', () => {
    expect(
      interpolateKeyframes(
        [
          { frame: -1, value: 0 },
          { frame: 0, value: NaN },
          { frame: 10, value: 100 },
        ] as never,
        5,
      ),
    ).toBe(100);
  });
});

describe('easing', () => {
  it('linear is identity', () => {
    expect(evaluateEasing('linear', 0)).toBe(0);
    expect(evaluateEasing('linear', 0.5)).toBeCloseTo(0.5, 9);
    expect(evaluateEasing('linear', 1)).toBe(1);
  });
  it('easeIn starts slow (below linear mid)', () => {
    expect(evaluateEasing('easeIn', 0)).toBe(0);
    expect(evaluateEasing('easeIn', 1)).toBe(1);
    expect(evaluateEasing('easeIn', 0.5)).toBeLessThan(0.5);
  });
  it('easeOut starts fast (above linear mid)', () => {
    expect(evaluateEasing('easeOut', 0)).toBe(0);
    expect(evaluateEasing('easeOut', 1)).toBe(1);
    expect(evaluateEasing('easeOut', 0.5)).toBeGreaterThan(0.5);
  });
  it('easeInOut is symmetric and endpoint-exact', () => {
    expect(evaluateEasing('easeInOut', 0)).toBe(0);
    expect(evaluateEasing('easeInOut', 1)).toBe(1);
    expect(evaluateEasing('easeInOut', 0.5)).toBeCloseTo(0.5, 9);
  });
  it('unknown easing falls back to linear', () => {
    expect(evaluateEasing('spring' as never, 0.25)).toBeCloseTo(0.25, 9);
  });
  it('clamps t outside [0,1]', () => {
    expect(evaluateEasing('linear', -2)).toBe(0);
    expect(evaluateEasing('linear', 2)).toBe(1);
  });
});

describe('animation + base values', () => {
  it('animation overrides the evaluated property without touching the base', () => {
    const d = doc({
      components: [
        inst({
          id: 'a',
          position: { x: 100, y: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: {
            tracks: [{ property: 'position.x', keyframes: [{ frame: 0, value: 100 }, { frame: 30, value: 500 }] }],
          },
        }),
      ],
    });
    const snapshot = JSON.stringify(d);
    const at15 = evaluateSceneAtFrame(d, 15);
    expect(at15.components[0].position.x).toBeCloseTo(300, 6);
    expect(JSON.stringify(d)).toBe(snapshot);
    expect(d.components[0].position.x).toBe(100);
  });

  it('supports the 8 animatable properties simultaneously', () => {
    expect([...ANIMATABLE_PROPERTIES].sort()).toEqual(
      [
        'position.x',
        'position.y',
        'size.width',
        'size.height',
        'transform.rotation',
        'transform.scaleX',
        'transform.scaleY',
        'style.opacity',
      ].sort(),
    );
    const d = doc({
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: {
            tracks: [
              { property: 'position.x', keyframes: [{ frame: 30, value: 300 }] },
              { property: 'position.y', keyframes: [{ frame: 30, value: 150 }] },
              { property: 'transform.rotation', keyframes: [{ frame: 30, value: 45 }] },
              { property: 'style.opacity', keyframes: [{ frame: 30, value: 0.8 }] },
            ],
          },
        }),
      ],
    });
    const at30 = evaluateSceneAtFrame(d, 30);
    expect(at30.components[0].position.x).toBe(300);
    expect(at30.components[0].position.y).toBe(150);
    expect(at30.components[0].transform.rotation).toBe(45);
    expect(at30.components[0].style.opacity).toBeCloseTo(0.8, 9);
  });

  it('ignores malformed property paths deterministically', () => {
    const d = doc({
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [{ property: 'position.z', keyframes: [{ frame: 0, value: 5 }] }] as never },
        }),
      ],
    });
    const out = evaluateSceneAtFrame(d, 10);
    expect(out.components[0].position).toEqual({ x: 0, y: 0 });
  });
});

describe('multiple instances, groups, references, z-order', () => {
  it('evaluates each instance independently', () => {
    const d = doc({
      components: [
        inst({ id: 'a', position: { x: 0, y: 0 }, timing: { startFrame: 0, durationFrames: 10 } }),
        inst({ id: 'b', position: { x: 0, y: 0 }, timing: { startFrame: 100, durationFrames: 10 } }),
      ],
    });
    const at5 = evaluateSceneAtFrame(d, 5);
    expect(at5.components.find((c) => c.id === 'a')?.visible).toBe(true);
    expect(at5.components.find((c) => c.id === 'b')?.visible).toBe(false);
  });

  it('preserves group hierarchy', () => {
    const d = doc({
      components: [inst({ id: 'a', groupId: 'g', timing: { startFrame: 0, durationFrames: 300 } })],
      groups: [{ id: 'g', parentGroupId: null, zIndex: 0 }],
    });
    const out = evaluateSceneAtFrame(d, 10);
    expect(out.groups).toEqual([{ id: 'g', parentGroupId: null, zIndex: 0 }]);
    expect(out.components[0].groupId).toBe('g');
    const tree = buildRenderTree(out);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe('group');
  });

  it('keeps references pointing at the same instance ids', () => {
    const d = doc({
      components: [
        inst({ id: 'f', timing: { startFrame: 0, durationFrames: 300 } }),
        inst({ id: 't', timing: { startFrame: 0, durationFrames: 300 } }),
        inst({ id: 'arrow', props: { from: 'f', to: 't' }, timing: { startFrame: 0, durationFrames: 300 } }),
      ],
    });
    const out = evaluateSceneAtFrame(d, 50);
    const arrow = out.components.find((c) => c.id === 'arrow');
    expect(arrow?.props).toEqual({ from: 'f', to: 't' });
    expect(out.components.map((c) => c.id)).toEqual(['f', 't', 'arrow']);
  });

  it('preserves input order (z-order input untouched)', () => {
    const d = doc({
      components: [
        inst({ id: 'high', zIndex: 9, timing: { startFrame: 0, durationFrames: 300 } }),
        inst({ id: 'low', zIndex: 1, timing: { startFrame: 0, durationFrames: 300 } }),
      ],
    });
    const out = evaluateSceneAtFrame(d, 5);
    expect(out.components.map((c) => c.id)).toEqual(['high', 'low']);
    // The render tree still sorts by z for painting.
    expect(buildPaintList(out).map((n) => n.instance.id)).toEqual(['low', 'high']);
  });

  it('feeds the existing render tree without breaking it', () => {
    const d = doc({
      components: [inst({ id: 'a', timing: { startFrame: 0, durationFrames: 300 } })],
    });
    const out = evaluateSceneAtFrame(d, 10);
    expect(buildPaintList(out)).toHaveLength(1);
    // Out-of-range frames keep the instance but hide it from the tree.
    const hidden = evaluateSceneAtFrame(d, 500);
    expect(hidden.components).toHaveLength(1);
    expect(buildPaintList(hidden)).toHaveLength(0);
  });
});

describe('non-mutation and determinism', () => {
  it('never mutates the input document', () => {
    const d = doc({
      components: [
        inst({
          id: 'a',
          position: { x: 1, y: 2 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [{ property: 'position.x', keyframes: [{ frame: 0, value: 10 }, { frame: 10, value: 20 }] }] },
        }),
      ],
      groups: [{ id: 'g', parentGroupId: null, zIndex: 3 }],
    });
    const before = JSON.stringify(d);
    evaluateSceneAtFrame(d, 5);
    evaluateSceneAtFrame(d, 50);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('is deterministic across repeated evaluations', () => {
    const d = doc({
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 10, durationFrames: 50 },
          animation: { tracks: [{ property: 'style.opacity', keyframes: [{ frame: 10, value: 0, easing: 'easeInOut' }, { frame: 60, value: 1 }] }] },
        }),
        inst({ id: 'b', groupId: 'g', timing: { startFrame: 0, durationFrames: 300 } }),
      ],
      groups: [{ id: 'g', parentGroupId: null, zIndex: 1 }],
    });
    expect(evaluateSceneAtFrame(d, 50)).toEqual(evaluateSceneAtFrame(d, 50));
  });

  it('handles boundary frames', () => {
    const timing = { startFrame: 30, durationFrames: 60 }; // 30..89
    const d = doc({ components: [inst({ id: 'a', timing })] });
    const vis = (f: number) => evaluateSceneAtFrame(d, f).components[0].visible;
    expect(vis(0)).toBe(false);
    expect(vis(29)).toBe(false);
    expect(vis(30)).toBe(true);
    expect(vis(59)).toBe(true);
    expect(vis(89)).toBe(true);
    expect(vis(90)).toBe(false);
    expect(vis(91)).toBe(false);
  });

  it('normalizes invalid frames deterministically', () => {
    expect(normalizeFrame(NaN)).toBe(0);
    expect(normalizeFrame(Infinity)).toBe(0);
    expect(normalizeFrame(4.9)).toBe(4);
    const d = doc({ components: [inst({ id: 'a', timing: { startFrame: 0, durationFrames: 300 } })] });
    expect(evaluateSceneAtFrame(d, NaN as never).frame).toBe(0);
  });

  it('resolves legacy seconds timing via fps', () => {
    expect(resolveTimingFrames({ start: 1, duration: 2 }, 30)).toEqual({
      startFrame: 30,
      durationFrames: 60,
      endFrame: 90,
    });
    // Frame fields win over legacy seconds.
    expect(resolveTimingFrames({ start: 999, duration: 999, startFrame: 5, durationFrames: 7 }, 30)).toEqual({
      startFrame: 5,
      durationFrames: 7,
      endFrame: 12,
    });
  });
});
