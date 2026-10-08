import { describe, expect, it } from 'vitest';
import {
  MOTION_ISSUE_CODES,
  MOTION_PRIMITIVES,
  MOTION_UNSUPPORTED_PRIMITIVES,
  compileMotion,
  findMotionConflicts,
  mergeMotionTracks,
  motionOffsetSeconds,
  motionRanks,
  planMotionWindows,
  resolveMotionTiming,
  verifyMotionApplication,
  type CompiledMotion,
  type MotionBaseValues,
  type MotionChoreography,
  type MotionCompileRequest,
  type MotionIssue,
  type MotionRawKeyframeOp,
  type MotionTargetInput,
} from '../src/index.js';

/**
 * Stage 4D — deterministic semantic motion engine.
 *
 * Every test here pins a documented behavior of the compiler: taxonomy and
 * capability gating, seconds→frames timing, per-primitive keyframe output,
 * option/choreography semantics, order-independent conflict detection,
 * window-ownership merging, bounded spring sampling, and application-side
 * verification. No test depends on wall-clock time, randomness, or locale.
 */

const timeline = { fps: 30, durationFrames: 300 };
const canvas = { width: 1600, height: 900 };

const BASE: MotionBaseValues = {
  position: { x: 100, y: 200 },
  size: { width: 300, height: 40 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 },
  style: { opacity: 1 },
};

const target = (overrides: Partial<MotionTargetInput> = {}): MotionTargetInput => ({
  id: 'i1',
  base: BASE,
  ...overrides,
});

const compileOne = (
  primitive: string,
  options?: Record<string, unknown>,
  extra: Partial<MotionCompileRequest> = {},
  targets: MotionTargetInput[] = [target()],
): CompiledMotion =>
  compileMotion({
    primitive,
    ...(options ? { options } : {}),
    targets,
    timeline,
    canvas,
    ...extra,
  });

const keyframesOf = (
  compiled: CompiledMotion,
  property: string,
  index = 0,
): Array<{ frame: number; value: number; easing: string }> =>
  compiled.targets[index]?.tracks.find((track) => track.property === property)?.keyframes ?? [];

const codes = (issues: MotionIssue[]): string[] => issues.map((issue) => issue.code);

// ---------------------------------------------------------------------------
// Taxonomy & capability gating
// ---------------------------------------------------------------------------

describe('motion taxonomy', () => {
  it('exposes exactly the required 16 supported primitives', () => {
    expect([...MOTION_PRIMITIVES]).toEqual([
      'fadeIn',
      'scaleIn',
      'slideIn',
      'popIn',
      'fadeOut',
      'scaleOut',
      'slideOut',
      'move',
      'scale',
      'resize',
      'rotate',
      'fade',
      'pulse',
      'bounce',
      'shake',
      'scaleEmphasis',
    ]);
  });

  it('declares capability-lacking primitives instead of faking them', () => {
    expect([...MOTION_UNSUPPORTED_PRIMITIVES]).toEqual([
      'wipeIn',
      'wipeOut',
      'revealIn',
      'drawIn',
      'typeIn',
      'blurIn',
      'blurOut',
      'colorChange',
      'textChange',
      'shapeChange',
      'morph',
      'cameraPan',
      'cameraZoom',
      'cameraFocus',
      'cameraShake',
      'cameraFollow',
    ]);
  });

  it('rejects declared-but-unsupported primitives with the capability code', () => {
    for (const primitive of ['wipeIn', 'typeIn', 'blurIn', 'drawIn', 'cameraPan', 'morph']) {
      const compiled = compileOne(primitive);
      expect(compiled.issues).toHaveLength(1);
      expect(compiled.issues[0]).toMatchObject({
        path: 'primitive',
        code: MOTION_ISSUE_CODES.UNSUPPORTED_RENDER_CAPABILITY,
      });
      expect(compiled.issues[0].message).toContain('rejected instead of being faked');
      expect(compiled.targets).toEqual([]);
    }
  });

  it('rejects unknown primitive names with the vocabulary code', () => {
    const compiled = compileOne('sparkle');
    expect(compiled.issues[0]).toMatchObject({
      path: 'primitive',
      code: MOTION_ISSUE_CODES.UNSUPPORTED_PRIMITIVE,
    });
    expect(compiled.issues[0].message).toContain('supported primitives');
    expect(compiled.targets).toEqual([]);
  });

  it('compiles every supported primitive cleanly with its minimal options', () => {
    const minimal: Record<string, Record<string, unknown>> = {
      fadeIn: {},
      scaleIn: {},
      slideIn: {},
      popIn: {},
      fadeOut: {},
      scaleOut: {},
      slideOut: {},
      move: { dx: 24 },
      scale: { factor: 1.5 },
      resize: { width: 240 },
      rotate: { degrees: 90 },
      fade: { from: 0, to: 1 },
      pulse: {},
      bounce: {},
      shake: {},
      scaleEmphasis: {},
    };
    for (const primitive of MOTION_PRIMITIVES) {
      const compiled = compileOne(primitive, minimal[primitive]);
      expect(compiled.issues, `${primitive} should compile without issues`).toEqual([]);
      expect(compiled.primitive).toBe(primitive);
      expect(compiled.targets, `${primitive} should emit at least one target`).toHaveLength(1);
      expect(compiled.targets[0].tracks.length).toBeGreaterThan(0);
    }
  });

  it('requires at least one resolved target', () => {
    const compiled = compileOne('fadeIn', {}, { targets: [] });
    expect(compiled.issues[0]).toMatchObject({
      path: 'targets',
      code: MOTION_ISSUE_CODES.TARGET_NOT_FOUND,
    });
  });
});

// ---------------------------------------------------------------------------
// Timing (seconds → frames)
// ---------------------------------------------------------------------------

describe('motion timing', () => {
  it('uses documented defaults (start 0, duration 0.5s → frames [0, 15])', () => {
    const compiled = compileOne('fadeIn');
    expect(compiled.targets[0].windows).toEqual([
      { property: 'style.opacity', startFrame: 0, endFrame: 15 },
    ]);
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);
  });

  it('converts seconds with Math.round(seconds * fps)', () => {
    const issues: MotionIssue[] = [];
    const result = resolveMotionTiming({ start: 0.05, duration: 1 }, timeline, issues);
    expect(issues).toEqual([]);
    // 0.05 * 30 = 1.5 → rounds to frame 2 (documented rounding).
    expect(result).toEqual({
      startFrame: 2,
      delayFrames: 0,
      durationFrames: 30,
      durationSeconds: 1,
    });
  });

  it('honors start + delay + duration, and end as a consistency check', () => {
    const issues: MotionIssue[] = [];
    const result = resolveMotionTiming(
      { start: 1, delay: 0.5, duration: 1, end: 2.5 },
      timeline,
      issues,
    );
    expect(issues).toEqual([]);
    expect(result).toEqual({
      startFrame: 30,
      delayFrames: 15,
      durationFrames: 30,
      durationSeconds: 1,
    });

    const mismatch: MotionIssue[] = [];
    resolveMotionTiming({ duration: 1, end: 3 }, timeline, mismatch);
    expect(mismatch[0]).toMatchObject({
      path: 'timing.end',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });
  });

  it('derives duration from end when duration is omitted', () => {
    const issues: MotionIssue[] = [];
    const result = resolveMotionTiming({ start: 1, delay: 0.5, end: 3 }, timeline, issues);
    expect(issues).toEqual([]);
    expect(result).toEqual({
      startFrame: 30,
      delayFrames: 15,
      durationFrames: 45,
      durationSeconds: 1.5,
    });
  });

  it('rejects zero, non-finite, and frame-rounding-to-zero durations', () => {
    const zero: MotionIssue[] = [];
    resolveMotionTiming({ duration: 0 }, timeline, zero);
    expect(zero[0]).toMatchObject({
      path: 'timing.duration',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });

    const nan: MotionIssue[] = [];
    resolveMotionTiming({ duration: Number.NaN }, timeline, nan);
    expect(nan[0]).toMatchObject({
      path: 'timing.duration',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });
    expect(nan[0].message).toContain('finite number');

    const dust: MotionIssue[] = [];
    resolveMotionTiming({ duration: 0.001 }, timeline, dust);
    expect(dust[0]).toMatchObject({
      path: 'timing.duration',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });
    expect(dust[0].message).toContain('rounds to 0 frames');
  });

  it('rejects end earlier than start + delay', () => {
    const issues: MotionIssue[] = [];
    resolveMotionTiming({ start: 5, end: 2 }, timeline, issues);
    expect(issues[0]).toMatchObject({
      path: 'timing.end',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });
    expect(issues[0].message).toContain('positive duration');
  });

  it('keeps the whole window inside the scene duration', () => {
    const issues: MotionIssue[] = [];
    resolveMotionTiming({ duration: 20 }, timeline, issues);
    expect(issues[0]).toMatchObject({ code: MOTION_ISSUE_CODES.INVALID_TIMING });
    expect(issues[0].message).toContain('beyond the scene duration');
  });

  it('enforces server-owned second limits', () => {
    const tooLate: MotionIssue[] = [];
    resolveMotionTiming({ start: 700 }, timeline, tooLate);
    expect(tooLate[0]).toMatchObject({
      path: 'timing.start',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });

    const tooLong: MotionIssue[] = [];
    resolveMotionTiming({ duration: 31 }, timeline, tooLong);
    expect(tooLong[0]).toMatchObject({
      path: 'timing.duration',
      code: MOTION_ISSUE_CODES.INVALID_TIMING,
    });
  });
});

// ---------------------------------------------------------------------------
// Per-primitive compilation (exact keyframes)
// ---------------------------------------------------------------------------

describe('motion primitives compile to keyframes', () => {
  it('fadeIn / fadeOut animate opacity from the base value', () => {
    const fadeIn = compileOne('fadeIn');
    expect(keyframesOf(fadeIn, 'style.opacity')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);

    const fadeOut = compileOne('fadeOut');
    expect(keyframesOf(fadeOut, 'style.opacity')).toEqual([
      { frame: 0, value: 1, easing: 'easeIn' },
      { frame: 15, value: 0, easing: 'linear' },
    ]);
  });

  it('fadeIn honors a base opacity that is not 1', () => {
    const compiled = compileOne('fadeIn', {}, {}, [
      target({ base: { ...BASE, style: { opacity: 0.4 } } }),
    ]);
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 0.4, easing: 'linear' },
    ]);
  });

  it('scaleIn / popIn scale from a factor up to the base scale', () => {
    const scaleIn = compileOne('scaleIn');
    expect(keyframesOf(scaleIn, 'transform.scaleX')).toEqual([
      { frame: 0, value: 0.5, easing: 'easeOut' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);
    expect(keyframesOf(scaleIn, 'transform.scaleY')).toEqual([
      { frame: 0, value: 0.5, easing: 'easeOut' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);

    const popIn = compileOne('popIn');
    expect(keyframesOf(popIn, 'transform.scaleX')).toEqual([
      { frame: 0, value: 0, easing: 'easeOutBack' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);
  });

  it('slideIn derives its start from geometry (never from the model)', () => {
    // bounds.x = 100 → distance = clamp(100, 48, 4000) = 100 → starts at 0.
    const fromLeft = compileOne('slideIn', { direction: 'left' });
    expect(keyframesOf(fromLeft, 'position.x')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 100, easing: 'linear' },
    ]);

    // distance right = canvas.width - (x + width) = 1600 - 400 = 1200.
    const fromRight = compileOne('slideIn', { direction: 'right' });
    expect(keyframesOf(fromRight, 'position.x')).toEqual([
      { frame: 0, value: 1300, easing: 'easeOut' },
      { frame: 15, value: 100, easing: 'linear' },
    ]);

    // top: distance = bounds.y = 200 → starts at 0.
    const fromTop = compileOne('slideIn', { direction: 'top' });
    expect(keyframesOf(fromTop, 'position.y')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 200, easing: 'linear' },
    ]);

    // bottom (default): distance = 900 - (200 + 40) = 660.
    const fromBottom = compileOne('slideIn');
    expect(keyframesOf(fromBottom, 'position.y')).toEqual([
      { frame: 0, value: 860, easing: 'easeOut' },
      { frame: 15, value: 200, easing: 'linear' },
    ]);
  });

  it('clamps derived slide distances into [48, 4000] and honors explicit distance', () => {
    const near = compileOne('slideIn', { direction: 'left' }, {}, [
      target({ base: { ...BASE, position: { x: 10, y: 200 } } }),
    ]);
    // 10 → clamped up to the 48px floor → start = 10 - 48 = -38.
    expect(keyframesOf(near, 'position.x')).toEqual([
      { frame: 0, value: -38, easing: 'easeOut' },
      { frame: 15, value: 10, easing: 'linear' },
    ]);

    const explicit = compileOne('slideIn', { direction: 'left', distance: 150 });
    expect(keyframesOf(explicit, 'position.x')).toEqual([
      { frame: 0, value: -50, easing: 'easeOut' },
      { frame: 15, value: 100, easing: 'linear' },
    ]);
  });

  it('slideOut exits toward the derived edge', () => {
    const compiled = compileOne('slideOut', { direction: 'left' });
    expect(keyframesOf(compiled, 'position.x')).toEqual([
      { frame: 0, value: 100, easing: 'easeIn' },
      { frame: 15, value: 0, easing: 'linear' },
    ]);
  });

  it('move animates only the axes with a non-zero delta', () => {
    const xOnly = compileOne('move', { dx: 50 });
    expect(keyframesOf(xOnly, 'position.x')).toEqual([
      { frame: 0, value: 100, easing: 'easeInOut' },
      { frame: 15, value: 150, easing: 'linear' },
    ]);
    expect(xOnly.targets[0].tracks).toHaveLength(1);

    const yOnly = compileOne('move', { dy: -30 });
    expect(keyframesOf(yOnly, 'position.y')).toEqual([
      { frame: 0, value: 200, easing: 'easeInOut' },
      { frame: 15, value: 170, easing: 'linear' },
    ]);
    expect(yOnly.targets[0].tracks).toHaveLength(1);
  });

  it('scale multiplies the base scale per axis', () => {
    const compiled = compileOne('scale', { factor: 2 });
    expect(keyframesOf(compiled, 'transform.scaleX')).toEqual([
      { frame: 0, value: 1, easing: 'easeInOut' },
      { frame: 15, value: 2, easing: 'linear' },
    ]);
    expect(keyframesOf(compiled, 'transform.scaleY')).toEqual([
      { frame: 0, value: 1, easing: 'easeInOut' },
      { frame: 15, value: 2, easing: 'linear' },
    ]);
  });

  it('resize animates size dimensions independently', () => {
    const compiled = compileOne('resize', { width: 400, height: 50 });
    expect(keyframesOf(compiled, 'size.width')).toEqual([
      { frame: 0, value: 300, easing: 'easeInOut' },
      { frame: 15, value: 400, easing: 'linear' },
    ]);
    expect(keyframesOf(compiled, 'size.height')).toEqual([
      { frame: 0, value: 40, easing: 'easeInOut' },
      { frame: 15, value: 50, easing: 'linear' },
    ]);
  });

  it('rotate uses easeInOut for degrees and linear for continuous cycles', () => {
    const degrees = compileOne('rotate', { degrees: 90 });
    expect(keyframesOf(degrees, 'transform.rotation')).toEqual([
      { frame: 0, value: 0, easing: 'easeInOut' },
      { frame: 15, value: 90, easing: 'linear' },
    ]);

    const cycles = compileOne('rotate', { cycles: 2 });
    expect(keyframesOf(cycles, 'transform.rotation')).toEqual([
      { frame: 0, value: 0, easing: 'linear' },
      { frame: 15, value: 720, easing: 'linear' },
    ]);
  });

  it('fade animates between explicit from/to values', () => {
    const compiled = compileOne('fade', { from: 0.2, to: 0.8 });
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 0.2, easing: 'easeInOut' },
      { frame: 15, value: 0.8, easing: 'linear' },
    ]);
  });

  it('pulse alternates base → factor → base and returns to the endpoint', () => {
    const compiled = compileOne('pulse', { factor: 1.5 }, { timing: { duration: 0.4 } });
    // 0.4s = 12 frames, 1 cycle = 2 segments → frames 0, 6, 12.
    expect(keyframesOf(compiled, 'transform.scaleX')).toEqual([
      { frame: 0, value: 1, easing: 'easeInOut' },
      { frame: 6, value: 1.5, easing: 'easeInOut' },
      { frame: 12, value: 1, easing: 'linear' },
    ]);
    expect(keyframesOf(compiled, 'transform.scaleY')).toEqual([
      { frame: 0, value: 1, easing: 'easeInOut' },
      { frame: 6, value: 1.5, easing: 'easeInOut' },
      { frame: 12, value: 1, easing: 'linear' },
    ]);
  });

  it('scaleEmphasis bumps scale once and returns to base', () => {
    const compiled = compileOne('scaleEmphasis', { factor: 1.25 }, { timing: { duration: 0.4 } });
    expect(keyframesOf(compiled, 'transform.scaleX')).toEqual([
      { frame: 0, value: 1, easing: 'easeInOut' },
      { frame: 6, value: 1.25, easing: 'easeInOut' },
      { frame: 12, value: 1, easing: 'linear' },
    ]);
  });

  it('bounce rises (easeOut) and falls (easeIn), ending exactly at base', () => {
    const compiled = compileOne('bounce', { height: 50 }, { timing: { duration: 0.4 } });
    expect(keyframesOf(compiled, 'position.y')).toEqual([
      { frame: 0, value: 200, easing: 'easeOut' },
      { frame: 6, value: 150, easing: 'easeIn' },
      { frame: 12, value: 200, easing: 'linear' },
    ]);
  });

  it('shake alternates +distance / -distance around the base value', () => {
    const compiled = compileOne(
      'shake',
      { distance: 10, cycles: 1, axis: 'x' },
      { timing: { duration: 0.4 } },
    );
    expect(keyframesOf(compiled, 'position.x')).toEqual([
      { frame: 0, value: 100, easing: 'linear' },
      { frame: 6, value: 110, easing: 'linear' },
      { frame: 12, value: 100, easing: 'linear' },
    ]);

    const both = compileOne(
      'shake',
      { distance: 10, cycles: 1, axis: 'both' },
      { timing: { duration: 0.4 } },
    );
    expect(both.targets[0].tracks.map((track) => track.property).sort()).toEqual([
      'position.x',
      'position.y',
    ]);
    expect(keyframesOf(both, 'position.y')).toEqual([
      { frame: 0, value: 200, easing: 'linear' },
      { frame: 6, value: 210, easing: 'linear' },
      { frame: 12, value: 200, easing: 'linear' },
    ]);
  });

  it('honors an explicit easing option on any primitive', () => {
    const compiled = compileOne('fadeIn', { easing: 'easeInQuad' });
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 0, easing: 'easeInQuad' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Option validation (MOTION_INVALID_OPTION)
// ---------------------------------------------------------------------------

describe('motion option validation', () => {
  const firstIssue = (
    primitive: string,
    options?: Record<string, unknown>,
  ): MotionIssue | undefined => compileOne(primitive, options).issues[0];

  it('rejects unknown option keys per primitive', () => {
    const issue = firstIssue('move', { dx: 10, wobble: true });
    expect(issue).toMatchObject({
      path: 'options.wobble',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(issue?.message).toContain('allowed: easing, spring, dx, dy');
  });

  it('enforces the server-owned option key cap', () => {
    const options: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) options[`key${i}`] = i;
    const issue = firstIssue('move', options);
    expect(issue).toMatchObject({ path: 'options', code: MOTION_ISSUE_CODES.INVALID_OPTION });
    expect(issue?.message).toContain('at most 16 keys');
  });

  it('requires primitive-specific inputs (move/scale/resize/rotate/fade)', () => {
    expect(firstIssue('move', {})).toMatchObject({
      path: 'options',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('move', { dx: 0, dy: 0 })?.message).toContain('non-zero delta');
    expect(firstIssue('scale', {})?.message).toContain('scale requires');
    expect(firstIssue('scale', { factor: 1 })?.message).toContain('differ from 1');
    expect(firstIssue('resize', {})?.message).toContain('resize requires');
    expect(firstIssue('rotate', {})?.message).toContain('rotate requires');
    expect(firstIssue('rotate', { degrees: 90, cycles: 1 })?.message).toContain('not both');
    expect(firstIssue('rotate', { degrees: 0 })?.message).toContain('non-zero');
    expect(firstIssue('fade', {})?.message).toContain('fade requires');
  });

  it('enforces numeric ranges on options', () => {
    expect(firstIssue('fade', { from: 2 })).toMatchObject({
      path: 'options.from',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('shake', { distance: 5000 })).toMatchObject({
      path: 'options.distance',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('resize', { width: 0 })).toMatchObject({
      path: 'options.width',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('pulse', { factor: 1 })?.message).toContain('differ from 1');
    expect(firstIssue('pulse', { cycles: 0 })).toMatchObject({
      path: 'options.cycles',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('move', { dx: Number.NaN })).toMatchObject({
      path: 'options.dx',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('slideIn', { direction: 'up' })).toMatchObject({
      path: 'options.direction',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
  });

  it('accepts only named timeline easings — never "spring"', () => {
    expect(firstIssue('fadeIn', { easing: 'spring' })).toMatchObject({
      path: 'options.easing',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('fadeIn', { easing: 'easeOutBack' })).toBeUndefined();
  });

  it('gates spring to entrance/exit/transform primitives with bounded params', () => {
    expect(firstIssue('pulse', { spring: {} })).toMatchObject({
      path: 'options.spring',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('shake', { spring: {} })?.message).toContain('not applicable');
    expect(firstIssue('fadeIn', { spring: { mass: 0 } })).toMatchObject({
      path: 'options.spring.mass',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });
    expect(firstIssue('fadeIn', { spring: { bounce: 2 } })?.message).toContain(
      'unknown spring option',
    );
  });
});

// ---------------------------------------------------------------------------
// Choreography (deterministic ranks + offsets)
// ---------------------------------------------------------------------------

describe('motion choreography', () => {
  it('computes ranks with simultaneous ties (no randomness)', () => {
    expect(motionRanks(5, 'forward')).toEqual([0, 1, 2, 3, 4]);
    expect(motionRanks(5, 'reverse')).toEqual([4, 3, 2, 1, 0]);
    // Ties (equal keys) share a rank: the middle and mirrored positions
    // start together for centerOut / edgesIn.
    expect(motionRanks(5, 'centerOut')).toEqual([3, 1, 0, 1, 3]);
    expect(motionRanks(5, 'edgesIn')).toEqual([0, 2, 4, 2, 0]);
  });

  it('maps ranks to documented offsets per mode', () => {
    const choreography = (partial: Partial<MotionChoreography>): MotionChoreography => ({
      mode: 'parallel',
      order: 'forward',
      stagger: 0,
      overlap: 0,
      ...partial,
    });
    expect(motionOffsetSeconds(3, choreography({ mode: 'parallel' }), 0.5)).toBe(0);
    expect(
      motionOffsetSeconds(3, choreography({ mode: 'stagger', stagger: 0.2 }), 0.5),
    ).toBeCloseTo(0.6);
    expect(
      motionOffsetSeconds(3, choreography({ mode: 'sequence', stagger: 0.1 }), 0.5),
    ).toBeCloseTo(1.8);
    expect(
      motionOffsetSeconds(3, choreography({ mode: 'overlap', overlap: 0.2 }), 0.5),
    ).toBeCloseTo(0.9);
  });

  const five = Array.from({ length: 5 }, (_, index) => target({ id: `i${index}` }));
  const starts = (
    choreography: Record<string, unknown>,
    primitiveOptions: Record<string, unknown> = {},
  ): number[] =>
    compileOne(
      'fadeIn',
      primitiveOptions,
      { choreography: choreography as MotionCompileRequest['choreography'] },
      five,
    ).targets.map((entry) => entry.windows[0].startFrame);

  it('parallel starts everyone together', () => {
    expect(starts({ mode: 'parallel' })).toEqual([0, 0, 0, 0, 0]);
  });

  it('stagger spaces starts by rank * stagger', () => {
    expect(starts({ mode: 'stagger', stagger: 0.2 })).toEqual([0, 6, 12, 18, 24]);
    expect(starts({ mode: 'stagger', stagger: 0.2, order: 'reverse' })).toEqual([
      24, 18, 12, 6, 0,
    ]);
    expect(starts({ mode: 'stagger', stagger: 0.2, order: 'centerOut' })).toEqual([
      18, 6, 0, 6, 18,
    ]);
    expect(starts({ mode: 'stagger', stagger: 0.2, order: 'edgesIn' })).toEqual([
      0, 12, 24, 12, 0,
    ]);
  });

  it('sequence chains each target after the previous window', () => {
    // duration 0.5s + explicit stagger 0 → rank * 15 frames.
    expect(starts({ mode: 'sequence', stagger: 0 })).toEqual([0, 15, 30, 45, 60]);
  });

  it('overlap pulls each start in by the overlap seconds', () => {
    // duration 0.5s - overlap 0.2s = 0.3s → rank * 9 frames.
    expect(starts({ mode: 'overlap', overlap: 0.2 })).toEqual([0, 9, 18, 27, 36]);
  });

  it('rejects unknown modes, orders, and out-of-range stagger/overlap', () => {
    const bad = compileOne('fadeIn', {}, { choreography: { mode: 'wave' } });
    expect(bad.issues[0]).toMatchObject({
      path: 'choreography.mode',
      code: MOTION_ISSUE_CODES.INVALID_OPTION,
    });

    const order = compileOne('fadeIn', {}, { choreography: { order: 'random' } });
    expect(order.issues[0]).toMatchObject({ path: 'choreography.order' });

    const stagger = compileOne('fadeIn', {}, { choreography: { stagger: 11 } });
    expect(stagger.issues[0]).toMatchObject({ path: 'choreography.stagger' });

    const overlap = compileOne('fadeIn', {}, { choreography: { overlap: -1 } });
    expect(overlap.issues[0]).toMatchObject({ path: 'choreography.overlap' });
  });

  it('reports choreography-shifted windows that leave the scene', () => {
    const compiled = compileOne(
      'fadeIn',
      {},
      {
        timeline: { fps: 30, durationFrames: 30 },
        choreography: { mode: 'sequence', stagger: 0 },
      },
      Array.from({ length: 4 }, (_, index) => target({ id: `i${index}` })),
    );
    // Windows 0/15/30 fit (ends 15/30/45/60): targets 2 and 3 leave the scene.
    expect(compiled.targets).toEqual([]);
    expect(compiled.issues).toHaveLength(2);
    expect(codes(compiled.issues)).toEqual([
      MOTION_ISSUE_CODES.INVALID_TIMING,
      MOTION_ISSUE_CODES.INVALID_TIMING,
    ]);
    expect(compiled.issues[0].message).toContain('beyond the scene duration');
  });
});

// ---------------------------------------------------------------------------
// Conflict detection (order-independent)
// ---------------------------------------------------------------------------

describe('motion conflict detection', () => {
  const windows = (opIndex: number, start: number) =>
    planMotionWindows({
      primitive: 'fadeIn',
      timing: { start, duration: 1 },
      targets: [target()],
      timeline,
      canvas,
    }).items.map((item) => ({ ...item, opIndex }));

  it('flags overlapping motion windows on the same target + property', () => {
    const prior = windows(0, 0); // [0, 30]
    const later = windows(1, 0.5); // [15, 45]
    const conflicts = findMotionConflicts({ items: later, priorItems: prior });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: MOTION_ISSUE_CODES.CONFLICT });
    expect(conflicts[0].message).toContain('overlaps motion op 0');

    // The same overlap is found regardless of argument order.
    const reversed = findMotionConflicts({ items: prior, priorItems: later });
    expect(reversed).toHaveLength(1);
    expect(reversed[0].message).toContain('overlaps motion op 1');
  });

  it('allows windows that touch at one boundary frame', () => {
    const prior = windows(0, 0); // [0, 30]
    const touching = windows(1, 1); // [30, 60]
    expect(findMotionConflicts({ items: touching, priorItems: prior })).toEqual([]);
  });

  it('flags raw keyframe frames inside a motion window (inclusive)', () => {
    const items = windows(0, 0); // [0, 30]
    const raw = (
      frames: number[],
      property = 'style.opacity',
      targetId = 'i1',
    ): MotionRawKeyframeOp[] => [
      { opIndex: 5, type: 'addKeyframe', targetId, property, frames },
    ];

    const inside = findMotionConflicts({ items, rawOps: raw([10]) });
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ code: MOTION_ISSUE_CODES.CONFLICT });
    expect(inside[0].message).toContain('addKeyframe op 5 frame 10');

    // The motion owns both endpoint frames too.
    expect(findMotionConflicts({ items, rawOps: raw([0]) })).toHaveLength(1);
    expect(findMotionConflicts({ items, rawOps: raw([30]) })).toHaveLength(1);

    // Outside the window, or on another property/target → no conflict.
    expect(findMotionConflicts({ items, rawOps: raw([31]) })).toEqual([]);
    expect(findMotionConflicts({ items, rawOps: raw([10], 'position.x') })).toEqual([]);
    expect(findMotionConflicts({ items, rawOps: raw([10], 'style.opacity', 'i2') })).toEqual(
      [],
    );
  });

  it('plans windows independently of base geometry values', () => {
    const request = (x: number): MotionCompileRequest => ({
      primitive: 'slideIn',
      options: { direction: 'left' },
      targets: [target({ base: { ...BASE, position: { x, y: 200 } } })],
      timeline,
      canvas,
    });
    const near = planMotionWindows(request(100));
    const far = planMotionWindows(request(1000));
    expect(near.issues).toEqual([]);
    expect(far.issues).toEqual([]);
    expect(near.items).toEqual(far.items);
  });
});

// ---------------------------------------------------------------------------
// Merge (motion owns its window, preserves the rest)
// ---------------------------------------------------------------------------

describe('motion track merging', () => {
  it('replaces only the keyframes inside the window', () => {
    const existing = [
      {
        property: 'style.opacity',
        keyframes: [
          { frame: 0, value: 1, easing: 'linear' },
          { frame: 10, value: 0.5, easing: 'linear' },
          { frame: 30, value: 0.2, easing: 'linear' },
          { frame: 100, value: 0.9, easing: 'linear' },
        ],
      },
      {
        property: 'position.x',
        keyframes: [
          { frame: 5, value: 10, easing: 'linear' },
          { frame: 50, value: 60, easing: 'linear' },
        ],
      },
    ];
    const compiled = compileMotion({
      primitive: 'fadeIn',
      timing: { duration: 1 }, // window [0, 30]
      targets: [target({ existingTracks: existing })],
      timeline,
      canvas,
    });
    const merged = compiled.targets[0].tracks;

    const opacity = merged.find((track) => track.property === 'style.opacity');
    expect(opacity?.keyframes).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 30, value: 1, easing: 'linear' },
      { frame: 100, value: 0.9, easing: 'linear' },
    ]);

    // A track outside every window is preserved untouched.
    const position = merged.find((track) => track.property === 'position.x');
    expect(position?.keyframes).toEqual([
      { frame: 5, value: 10, easing: 'linear' },
      { frame: 50, value: 60, easing: 'linear' },
    ]);
  });

  it('keeps existing keyframes outside a later motion window', () => {
    const compiled = compileMotion({
      primitive: 'fadeIn',
      timing: { start: 0.5, duration: 1 }, // window [15, 45]
      targets: [
        target({
          existingTracks: [
            {
              property: 'style.opacity',
              keyframes: [
                { frame: 0, value: 1, easing: 'linear' },
                { frame: 100, value: 0.5, easing: 'linear' },
              ],
            },
          ],
        }),
      ],
      timeline,
      canvas,
    });
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 1, easing: 'linear' },
      { frame: 15, value: 0, easing: 'easeOut' },
      { frame: 45, value: 1, easing: 'linear' },
      { frame: 100, value: 0.5, easing: 'linear' },
    ]);
  });

  it('is idempotent: compiling over its own output changes nothing', () => {
    const request: MotionCompileRequest = {
      primitive: 'move',
      options: { dx: 40 },
      timing: { start: 1, duration: 1 },
      targets: [target()],
      timeline,
      canvas,
    };
    const first = compileMotion(request);
    const second = compileMotion({
      ...request,
      targets: [target({ existingTracks: first.targets[0].tracks })],
    });
    expect(second.targets[0].tracks).toEqual(first.targets[0].tracks);
    expect(second).toEqual(
      compileMotion({
        ...request,
        targets: [target({ existingTracks: first.targets[0].tracks })],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Spring (closed-form, bounded samples)
// ---------------------------------------------------------------------------

describe('motion spring', () => {
  const springRequest = (): MotionCompileRequest => ({
    primitive: 'fadeIn',
    options: { spring: {} },
    timing: { duration: 1 }, // 30 frames → 30 samples (≤ 48 cap)
    targets: [target()],
    timeline,
    canvas,
  });

  it('samples the oscillator into bounded keyframes that settle on the target', () => {
    const compiled = compileMotion(springRequest());
    const keyframes = keyframesOf(compiled, 'style.opacity');
    expect(keyframes).toHaveLength(31);
    expect(keyframes[0]).toEqual({ frame: 0, value: 0, easing: 'linear' });
    expect(keyframes[keyframes.length - 1]).toEqual({ frame: 30, value: 1, easing: 'linear' });
    for (const keyframe of keyframes) {
      expect(Number.isFinite(keyframe.value)).toBe(true);
      expect(keyframe.value).toBeGreaterThanOrEqual(0);
      expect(keyframe.value).toBeLessThanOrEqual(1.5); // bounded overshoot
    }
  });

  it('is deterministic: identical requests compile identically', () => {
    expect(compileMotion(springRequest())).toEqual(compileMotion(springRequest()));
  });
});

// ---------------------------------------------------------------------------
// Determinism & numeric safety
// ---------------------------------------------------------------------------

describe('motion determinism & numeric safety', () => {
  it('compiles byte-identical output for identical requests', () => {
    const request = (): MotionCompileRequest => ({
      primitive: 'slideIn',
      options: { direction: 'left' },
      timing: { start: 0.3, duration: 0.7 },
      choreography: { mode: 'stagger', stagger: 0.1 },
      targets: [target({ id: 'a' }), target({ id: 'b' })],
      timeline,
      canvas,
    });
    const first = compileMotion(request());
    const second = compileMotion(request());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.issues).toEqual([]);
  });

  it('never emits NaN or Infinity from garbage base values', () => {
    const garbage: MotionBaseValues = {
      position: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      size: { width: Number.NaN, height: Number.NEGATIVE_INFINITY },
      transform: {
        rotation: Number.NaN,
        scaleX: Number.NaN,
        scaleY: Number.POSITIVE_INFINITY,
      },
      style: { opacity: Number.NaN },
    };
    const compiled = compileMotion({
      primitive: 'fadeIn',
      targets: [target({ base: garbage })],
      timeline,
      canvas,
    });
    // opacity NaN falls back to 1 — keyframes stay finite and in [0, 1].
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);

    const slide = compileMotion({
      primitive: 'slideIn',
      options: { direction: 'left' },
      targets: [target({ base: garbage })],
      timeline,
      canvas,
    });
    // x NaN → 0 → derived distance clamps to the 48px floor.
    expect(keyframesOf(slide, 'position.x')).toEqual([
      { frame: 0, value: -48, easing: 'easeOut' },
      { frame: 15, value: 0, easing: 'linear' },
    ]);

    for (const entry of [...compiled.targets, ...slide.targets]) {
      for (const track of entry.tracks) {
        for (const keyframe of track.keyframes) {
          expect(Number.isFinite(keyframe.frame)).toBe(true);
          expect(Number.isFinite(keyframe.value)).toBe(true);
        }
      }
    }
  });

  it('clamps opacity into [0, 1] even when the base is out of range', () => {
    const compiled = compileOne('fadeIn', {}, {}, [
      target({ base: { ...BASE, style: { opacity: 5 } } }),
    ]);
    expect(keyframesOf(compiled, 'style.opacity')).toEqual([
      { frame: 0, value: 0, easing: 'easeOut' },
      { frame: 15, value: 1, easing: 'linear' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Application-side verification
// ---------------------------------------------------------------------------

describe('motion verification', () => {
  const request = (): MotionCompileRequest => ({
    primitive: 'fadeIn',
    timing: { duration: 1 },
    targets: [target()],
    timeline,
    canvas,
  });

  it('passes when the stored keyframes match a fresh compilation', () => {
    const compiled = compileMotion(request());
    const stored = compiled.targets.map((entry) => ({
      id: entry.id,
      base: BASE,
      existingTracks: entry.tracks,
    }));
    expect(verifyMotionApplication({ ...request(), targets: stored })).toEqual({
      passed: true,
      issues: [],
    });
  });

  it('fails when a stored value was tampered with', () => {
    const compiled = compileMotion(request());
    const stored = compiled.targets.map((entry) => ({
      id: entry.id,
      base: BASE,
      existingTracks: entry.tracks.map((track) =>
        track.property === 'style.opacity'
          ? {
              ...track,
              keyframes: track.keyframes.map((keyframe) =>
                // The window end (frame 30, value 1) is the expected keyframe
                // verification diffs against — corrupt it by a wide margin.
                keyframe.frame === 30 ? { ...keyframe, value: 0.5 } : keyframe,
              ),
            }
          : track,
      ),
    }));
    const result = verifyMotionApplication({ ...request(), targets: stored });
    expect(result.passed).toBe(false);
    expect(result.issues[0]).toContain('expected 1');
  });

  it('fails when the expected track is missing entirely', () => {
    const result = verifyMotionApplication({
      ...request(),
      targets: [{ id: 'i1', base: BASE, existingTracks: [] }],
    });
    expect(result.passed).toBe(false);
    expect(result.issues[0]).toContain('expected motion track style.opacity is missing');
  });
});
