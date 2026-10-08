import { boundsOf } from './geometry.js';
import { WORLD, type RenderBounds } from './types.js';
import {
  isAnimatableProperty,
  isEasingName,
  normalizeKeyframes,
  resolveTimeline,
  type AnimatableProperty,
  type AnimationTrack,
  type EasingName,
  type TimelineKeyframe,
} from './timeline.js';

/**
 * Deterministic motion design engine (Stage 4D).
 *
 *   motion intent (primitive + timing + options + choreography)
 *     → compileMotion(request) → AnimationTracks (existing timeline shape)
 *     → Timeline evaluator → Render tree → Renderer → Remotion
 *
 * This is a COMPILER, not a second pipeline: it never invents a new
 * animation model. Its only output is ordinary `AnimationTrack`s on the
 * eight existing animatable properties, merged into the instance's existing
 * `animation.tracks` by the existing document mutation path. The stored
 * document base values (position/size/transform/style) are never modified —
 * tracks override them at evaluation time, exactly like hand-authored
 * keyframes.
 *
 * Ownership & precedence (documented conflict rule):
 *   - Tracks are keyed by (instance, property).
 *   - A motion window W = [startFrame, endFrame] fully OWNS its keyframes:
 *     compiling replaces stored keyframes with frame inside W and preserves
 *     every keyframe outside W (idempotent by construction — identity is
 *     derived from the window, so there is no persisted motion id).
 *   - Two motion items on the same target+property conflict when their
 *     windows overlap with positive length (`a.start < b.end && b.start <
 *     a.end`); windows may touch at a single boundary frame. A raw
 *     addKeyframe/addAnimationTrack/deleteKeyframe frame inside a motion
 *     window (inclusive) conflicts with that motion. Conflicts are detected
 *     by the caller before apply (order-independent) and reported as
 *     MOTION_CONFLICT — the engine never silently picks a winner.
 *   - Motion always compiles from the document BASE values, never from
 *     another animation's interpolated values.
 *
 * Determinism: pure data in → plain data out. No Date.now, no Math.random,
 * no UUIDs, no environment APIs; stable ordering (input order + explicit
 * choreography ranks); every emitted value is finite and rounded to 2
 * decimals (the Stage 4C geometry convention). Runs identically in the API,
 * browsers, and workers. Never mutates its inputs.
 *
 * Capability gating: primitives the render pipeline cannot honestly
 * express (wipe/blur/type/draw/camera effects) are declared here and
 * rejected with MOTION_UNSUPPORTED_RENDER_CAPABILITY — never faked with an
 * approximation.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export type MotionPrimitive =
  | 'fadeIn'
  | 'scaleIn'
  | 'slideIn'
  | 'popIn'
  | 'fadeOut'
  | 'scaleOut'
  | 'slideOut'
  | 'move'
  | 'scale'
  | 'resize'
  | 'rotate'
  | 'fade'
  | 'pulse'
  | 'bounce'
  | 'shake'
  | 'scaleEmphasis';

/** Primitives the engine compiles to real property tracks. */
export const MOTION_PRIMITIVES: readonly MotionPrimitive[] = [
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
] as const;

/**
 * Declared-but-unsupported primitives. They are part of the vocabulary so a
 * model can reference them, but this pipeline has no honest implementation
 * (masks, blur filters, text reveal, stroke drawing, camera/viewport
 * transforms do not exist in the render tree) — each fails deterministically
 * instead of degrading into a fake effect.
 */
export const MOTION_UNSUPPORTED_PRIMITIVES = [
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
] as const;

export const isMotionPrimitiveSupported = (value: unknown): value is MotionPrimitive =>
  typeof value === 'string' &&
  (MOTION_PRIMITIVES as readonly string[]).includes(value);

export const isDeclaredMotionPrimitive = (value: unknown): boolean =>
  typeof value === 'string' &&
  ((MOTION_PRIMITIVES as readonly string[]).includes(value) ||
    (MOTION_UNSUPPORTED_PRIMITIVES as readonly string[]).includes(value));

export type MotionDirection = 'left' | 'right' | 'top' | 'bottom';
export type MotionAxis = 'x' | 'y' | 'both';
export type MotionChoreographyMode = 'sequence' | 'parallel' | 'overlap' | 'stagger';
export type MotionChoreographyOrder = 'forward' | 'reverse' | 'centerOut' | 'edgesIn';

export const MOTION_DIRECTIONS: readonly MotionDirection[] = [
  'left',
  'right',
  'top',
  'bottom',
] as const;
export const MOTION_AXES: readonly MotionAxis[] = ['x', 'y', 'both'] as const;
export const MOTION_CHOREOGRAPHY_MODES: readonly MotionChoreographyMode[] = [
  'sequence',
  'parallel',
  'overlap',
  'stagger',
] as const;
export const MOTION_CHOREOGRAPHY_ORDERS: readonly MotionChoreographyOrder[] = [
  'forward',
  'reverse',
  'centerOut',
  'edgesIn',
] as const;

// ---------------------------------------------------------------------------
// Error codes (deterministic; surfaced as plan issues by the AI layer)
// ---------------------------------------------------------------------------

export const MOTION_ISSUE_CODES = {
  /** Target refs/groups do not resolve, or the scope is empty. */
  TARGET_NOT_FOUND: 'MOTION_TARGET_NOT_FOUND',
  /** Primitive name is not part of the motion vocabulary at all. */
  UNSUPPORTED_PRIMITIVE: 'MOTION_UNSUPPORTED_PRIMITIVE',
  /** Declared primitive needs a render capability this pipeline lacks. */
  UNSUPPORTED_RENDER_CAPABILITY: 'MOTION_UNSUPPORTED_RENDER_CAPABILITY',
  /** Non-finite/zero/out-of-range seconds, bad end consistency, out of scene. */
  INVALID_TIMING: 'MOTION_INVALID_TIMING',
  /** Unknown/wrong-typed/out-of-range/inapplicable option. */
  INVALID_OPTION: 'MOTION_INVALID_OPTION',
  /** Ambiguous overlapping intent on the same target+property. */
  CONFLICT: 'MOTION_CONFLICT',
  /** Engine-internal defensive failure (should be unreachable post-validation). */
  COMPILATION_ERROR: 'MOTION_COMPILATION_ERROR',
  /** Server-owned scope/keyframe budget exceeded. */
  TARGET_LIMIT: 'MOTION_TARGET_LIMIT',
} as const;

export interface MotionIssue {
  /** Path relative to the motion operation (e.g. `timing.duration`). */
  path: string;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Server-owned limits & defaults
// ---------------------------------------------------------------------------

export const MOTION_DEFAULT_DURATION_SECONDS = 0.5;
export const MOTION_MAX_DURATION_SECONDS = 30;
export const MOTION_MAX_START_SECONDS = 600;
export const MOTION_MAX_DELAY_SECONDS = 600;
export const MOTION_MAX_CHOREOGRAPHY_STAGGER_SECONDS = 10;
export const MOTION_MAX_CHOREOGRAPHY_OVERLAP_SECONDS = 10;
/** Explicit slide distance cap; derived distances clamp into [48, 4000]. */
export const MOTION_MAX_DISTANCE = 4000;
export const MOTION_MIN_DERIVED_DISTANCE = 48;
export const MOTION_MAX_OPTION_KEYS = 16;
export const MOTION_MAX_CYCLES = 10;
export const MOTION_MAX_RESIZE = 8000;
export const MOTION_MAX_ROTATE_DEGREES = 36000;
export const MOTION_MAX_ROTATE_CYCLES = 100;
export const MOTION_MAX_SCALE_FACTOR = 100;
export const MOTION_MAX_SHAKE_DISTANCE = 1000;
export const MOTION_MAX_BOUNCE_HEIGHT = 4000;
/** Sampled spring keyframes per window (bounded keyframe growth). */
export const MOTION_SPRING_MAX_SAMPLES = 48;
/** Structural cap on reported issues per operation/verification run. */
export const MOTION_MAX_ISSUES = 12;
/** Value comparison tolerance for motion verification (matches layout rounding). */
export const MOTION_VALUE_TOLERANCE = 0.01;
/** Server-owned cap on resolved targets (explicit refs ∪ group members). */
export const MOTION_MAX_RESOLVED_TARGETS = 500;

export const MOTION_SPRING_DEFAULTS = {
  mass: 1,
  stiffness: 100,
  damping: 10,
} as const;

export const MOTION_SPRING_BOUNDS = {
  massMin: 0.1,
  massMax: 10,
  stiffnessMin: 1,
  stiffnessMax: 1000,
  dampingMin: 0.1,
  dampingMax: 100,
} as const;

/** Allowed option keys per primitive (unknown keys are rejected). */
const COMMON_OPTION_KEYS = ['easing', 'spring'] as const;
export const MOTION_OPTION_KEYS: Record<MotionPrimitive, readonly string[]> = {
  fadeIn: [...COMMON_OPTION_KEYS, 'from'],
  scaleIn: [...COMMON_OPTION_KEYS, 'from'],
  slideIn: [...COMMON_OPTION_KEYS, 'direction', 'distance'],
  popIn: [...COMMON_OPTION_KEYS, 'from'],
  fadeOut: [...COMMON_OPTION_KEYS, 'to'],
  scaleOut: [...COMMON_OPTION_KEYS, 'to'],
  slideOut: [...COMMON_OPTION_KEYS, 'direction', 'distance'],
  move: [...COMMON_OPTION_KEYS, 'dx', 'dy'],
  scale: [...COMMON_OPTION_KEYS, 'factor', 'factorX', 'factorY'],
  resize: [...COMMON_OPTION_KEYS, 'width', 'height'],
  rotate: [...COMMON_OPTION_KEYS, 'degrees', 'cycles'],
  fade: [...COMMON_OPTION_KEYS, 'from', 'to'],
  pulse: [...COMMON_OPTION_KEYS, 'factor', 'cycles'],
  bounce: [...COMMON_OPTION_KEYS, 'height', 'cycles'],
  shake: [...COMMON_OPTION_KEYS, 'distance', 'cycles', 'axis'],
  scaleEmphasis: [...COMMON_OPTION_KEYS, 'factor'],
};

const EMPHASIS_PRIMITIVES: ReadonlySet<string> = new Set([
  'pulse',
  'bounce',
  'shake',
  'scaleEmphasis',
]);

/** Primitives whose single primary segment may be replaced by a spring curve. */
const SPRING_COMPATIBLE: ReadonlySet<string> = new Set([
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
]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const round2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

const toFinite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const addIssue = (
  issues: MotionIssue[],
  path: string,
  code: string,
  message: string,
): void => {
  if (issues.length < MOTION_MAX_ISSUES) issues.push({ path, code, message });
};

const listValues = (values: readonly string[]): string =>
  values.join(', ');

// ---------------------------------------------------------------------------
// Timing (seconds → frames, boundary conventions)
// ---------------------------------------------------------------------------

export interface MotionTimingInput {
  start?: unknown;
  delay?: unknown;
  duration?: unknown;
  end?: unknown;
}

export interface MotionTimingFrames {
  startFrame: number;
  delayFrames: number;
  durationFrames: number;
  durationSeconds: number;
}

const readFiniteNumber = (
  raw: unknown,
  path: string,
  label: string,
  min: number,
  max: number,
  issues: MotionIssue[],
): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    addIssue(
      issues,
      path,
      MOTION_ISSUE_CODES.INVALID_TIMING,
      `${label} must be a finite number of seconds`,
    );
    return undefined;
  }
  if (raw < min) {
    addIssue(
      issues,
      path,
      MOTION_ISSUE_CODES.INVALID_TIMING,
      `${label} must be at least ${min} second`,
    );
    return undefined;
  }
  if (raw > max) {
    addIssue(
      issues,
      path,
      MOTION_ISSUE_CODES.INVALID_TIMING,
      `${label} must be at most ${max} seconds`,
    );
    return undefined;
  }
  return raw;
};

/**
 * Resolve op timing into frames. Conventions match the existing timeline:
 * `frames = Math.max(0, Math.round(seconds * fps))`, visibility/value
 * windows are inclusive `[start, end]` for keyframes, and the whole window
 * must fit inside the scene duration.
 */
export const resolveMotionTiming = (
  timing: MotionTimingInput | null | undefined,
  timeline: { fps: number; durationFrames: number },
  issues: MotionIssue[],
): MotionTimingFrames | null => {
  const issuesBefore = issues.length;
  const raw = timing ?? {};
  const start = readFiniteNumber(
    raw.start,
    'timing.start',
    'timing.start',
    0,
    MOTION_MAX_START_SECONDS,
    issues,
  );
  const delay = readFiniteNumber(
    raw.delay,
    'timing.delay',
    'timing.delay',
    0,
    MOTION_MAX_DELAY_SECONDS,
    issues,
  );
  const explicitDuration = readFiniteNumber(
    raw.duration,
    'timing.duration',
    'timing.duration',
    0,
    MOTION_MAX_DURATION_SECONDS + 1,
    issues,
  );
  const end = readFiniteNumber(
    raw.end,
    'timing.end',
    'timing.end',
    0,
    MOTION_MAX_START_SECONDS + MOTION_MAX_DELAY_SECONDS + MOTION_MAX_DURATION_SECONDS + 1,
    issues,
  );

  const startSeconds = start ?? 0;
  const delaySeconds = delay ?? 0;

  let durationSeconds: number;
  if (explicitDuration !== undefined && end !== undefined) {
    const implied = startSeconds + delaySeconds + explicitDuration;
    if (Math.abs(end - implied) > 1e-6) {
      addIssue(
        issues,
        'timing.end',
        MOTION_ISSUE_CODES.INVALID_TIMING,
        `timing.end (${end}) must equal start + delay + duration (${implied})`,
      );
    }
    durationSeconds = explicitDuration;
  } else if (explicitDuration !== undefined) {
    durationSeconds = explicitDuration;
  } else if (end !== undefined) {
    durationSeconds = end - startSeconds - delaySeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      addIssue(
        issues,
        'timing.end',
        MOTION_ISSUE_CODES.INVALID_TIMING,
        'timing.end must be later than start + delay so the motion has a positive duration',
      );
      durationSeconds = MOTION_DEFAULT_DURATION_SECONDS;
    }
  } else {
    durationSeconds = MOTION_DEFAULT_DURATION_SECONDS;
  }

  if (explicitDuration !== undefined && explicitDuration <= 0) {
    addIssue(
      issues,
      'timing.duration',
      MOTION_ISSUE_CODES.INVALID_TIMING,
      'timing.duration must be greater than 0 seconds',
    );
  }
  if (durationSeconds > MOTION_MAX_DURATION_SECONDS) {
    addIssue(
      issues,
      'timing.duration',
      MOTION_ISSUE_CODES.INVALID_TIMING,
      `timing.duration must be at most ${MOTION_MAX_DURATION_SECONDS} seconds`,
    );
  }
  if (issues.length > issuesBefore) return null;

  const startFrame = Math.max(0, Math.round(startSeconds * timeline.fps));
  const delayFrames = Math.max(0, Math.round(delaySeconds * timeline.fps));
  const durationFrames = Math.round(durationSeconds * timeline.fps);
  if (durationFrames < 1) {
    addIssue(
      issues,
      'timing.duration',
      MOTION_ISSUE_CODES.INVALID_TIMING,
      `timing.duration rounds to 0 frames at ${timeline.fps} fps; use at least ${(1 / timeline.fps).toFixed(4)} seconds`,
    );
    return null;
  }
  const endFrame = startFrame + delayFrames + durationFrames;
  if (endFrame > timeline.durationFrames) {
    addIssue(
      issues,
      'timing',
      MOTION_ISSUE_CODES.INVALID_TIMING,
      `motion window ends at frame ${endFrame}, beyond the scene duration (${timeline.durationFrames} frames)`,
    );
    return null;
  }
  return { startFrame, delayFrames, durationFrames, durationSeconds };
};

// ---------------------------------------------------------------------------
// Choreography (ranks + offsets; no randomness, ties are simultaneous)
// ---------------------------------------------------------------------------

export interface MotionChoreographyInput {
  mode?: unknown;
  order?: unknown;
  stagger?: unknown;
  overlap?: unknown;
}

export interface MotionChoreography {
  mode: MotionChoreographyMode;
  order: MotionChoreographyOrder;
  stagger: number;
  overlap: number;
}

export const MOTION_DEFAULT_CHOREOGRAPHY: MotionChoreography = {
  mode: 'parallel',
  order: 'forward',
  stagger: 0.1,
  overlap: 0.5,
};

export const resolveMotionChoreography = (
  raw: MotionChoreographyInput | null | undefined,
  issues: MotionIssue[],
): MotionChoreography => {
  const result: MotionChoreography = { ...MOTION_DEFAULT_CHOREOGRAPHY };
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    addIssue(
      issues,
      'choreography',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      'choreography must be an object',
    );
    return result;
  }
  if (raw.mode !== undefined) {
    if (
      typeof raw.mode !== 'string' ||
      !(MOTION_CHOREOGRAPHY_MODES as readonly string[]).includes(raw.mode)
    ) {
      addIssue(
        issues,
        'choreography.mode',
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `choreography.mode must be one of: ${listValues(MOTION_CHOREOGRAPHY_MODES)}`,
      );
    } else {
      result.mode = raw.mode as MotionChoreographyMode;
    }
  }
  if (raw.order !== undefined) {
    if (
      typeof raw.order !== 'string' ||
      !(MOTION_CHOREOGRAPHY_ORDERS as readonly string[]).includes(raw.order)
    ) {
      addIssue(
        issues,
        'choreography.order',
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `choreography.order must be one of: ${listValues(MOTION_CHOREOGRAPHY_ORDERS)}`,
      );
    } else {
      result.order = raw.order as MotionChoreographyOrder;
    }
  }
  const ranged = (
    value: unknown,
    key: 'stagger' | 'overlap',
    max: number,
  ): void => {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      addIssue(
        issues,
        `choreography.${key}`,
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `choreography.${key} must be a finite number of seconds`,
      );
      return;
    }
    if (value < 0 || value > max) {
      addIssue(
        issues,
        `choreography.${key}`,
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `choreography.${key} must be between 0 and ${max} seconds`,
      );
      return;
    }
    result[key] = value;
  };
  ranged(raw.stagger, 'stagger', MOTION_MAX_CHOREOGRAPHY_STAGGER_SECONDS);
  ranged(raw.overlap, 'overlap', MOTION_MAX_CHOREOGRAPHY_OVERLAP_SECONDS);
  return result;
};

/**
 * Choreography rank per item index. A rank is the number of items ordered
 * before it — equal keys get equal ranks (simultaneous starts). No
 * randomness anywhere; ties break on document/plan order via the keys.
 */
export const motionRanks = (
  count: number,
  order: MotionChoreographyOrder,
): number[] => {
  const center = (count - 1) / 2;
  const keyOf = (index: number): number => {
    switch (order) {
      case 'forward':
        return index;
      case 'reverse':
        return -index;
      case 'centerOut':
        return Math.abs(index - center);
      case 'edgesIn':
        return -Math.abs(index - center);
    }
  };
  const keys = Array.from({ length: count }, (_, index) => keyOf(index));
  // Rank = number of items ordered strictly before this one: equal keys get
  // equal ranks, so centerOut/edgesIn ties start simultaneously.
  return keys.map((key) => keys.filter((other) => other < key).length);
};

/** Start offset (seconds) for an item at choreography `rank`. */
export const motionOffsetSeconds = (
  rank: number,
  choreography: MotionChoreography,
  durationSeconds: number,
): number => {
  switch (choreography.mode) {
    case 'parallel':
      return 0;
    case 'stagger':
      return rank * choreography.stagger;
    case 'sequence':
      return rank * (durationSeconds + choreography.stagger);
    case 'overlap':
      return rank * Math.max(0, durationSeconds - choreography.overlap);
  }
};

// ---------------------------------------------------------------------------
// Option parsing (semantic; MOTION_INVALID_OPTION)
// ---------------------------------------------------------------------------

export interface NormalizedMotionOptions {
  easing?: EasingName;
  spring?: { mass: number; stiffness: number; damping: number };
  from?: number;
  to?: number;
  direction?: MotionDirection;
  distance?: number;
  dx?: number;
  dy?: number;
  factor?: number;
  factorX?: number;
  factorY?: number;
  width?: number;
  height?: number;
  degrees?: number;
  cycles?: number;
  axis?: MotionAxis;
}

const numberOption = (
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  issues: MotionIssue[],
): number | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(
      issues,
      `options.${key}`,
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `options.${key} must be a finite number`,
    );
    return undefined;
  }
  if (value < min || value > max) {
    addIssue(
      issues,
      `options.${key}`,
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `options.${key} must be between ${min} and ${max}`,
    );
    return undefined;
  }
  return value;
};

const integerOption = (
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  issues: MotionIssue[],
): number | undefined => {
  const value = numberOption(record, key, min, max, issues);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    addIssue(
      issues,
      `options.${key}`,
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `options.${key} must be an integer`,
    );
    return undefined;
  }
  return value;
};

const enumOption = <T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  issues: MotionIssue[],
): T | undefined => {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    addIssue(
      issues,
      `options.${key}`,
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `options.${key} must be one of: ${listValues(allowed)}`,
    );
    return undefined;
  }
  return value as T;
};

const parseSpring = (
  primitive: MotionPrimitive,
  raw: unknown,
  issues: MotionIssue[],
): { mass: number; stiffness: number; damping: number } | undefined => {
  if (raw === undefined) return undefined;
  if (EMPHASIS_PRIMITIVES.has(primitive)) {
    addIssue(
      issues,
      'options.spring',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `spring is not applicable to the "${primitive}" emphasis primitive; use an entrance, exit, or transform primitive`,
    );
    return undefined;
  }
  if (!SPRING_COMPATIBLE.has(primitive)) {
    addIssue(
      issues,
      'options.spring',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `spring is not applicable to "${primitive}"`,
    );
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    addIssue(
      issues,
      'options.spring',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      'options.spring must be an object { mass?, stiffness?, damping? }',
    );
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['mass', 'stiffness', 'damping'].includes(key)) {
      addIssue(
        issues,
        `options.spring.${key}`,
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `unknown spring option "${key}"; allowed: mass, stiffness, damping`,
      );
    }
  }
  const field = (key: 'mass' | 'stiffness' | 'damping', min: number, max: number): number | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      addIssue(
        issues,
        `options.spring.${key}`,
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `options.spring.${key} must be a finite number`,
      );
      return undefined;
    }
    if (value < min || value > max) {
      addIssue(
        issues,
        `options.spring.${key}`,
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `options.spring.${key} must be between ${min} and ${max}`,
      );
      return undefined;
    }
    return value;
  };
  const mass = field('mass', MOTION_SPRING_BOUNDS.massMin, MOTION_SPRING_BOUNDS.massMax);
  const stiffness = field(
    'stiffness',
    MOTION_SPRING_BOUNDS.stiffnessMin,
    MOTION_SPRING_BOUNDS.stiffnessMax,
  );
  const damping = field(
    'damping',
    MOTION_SPRING_BOUNDS.dampingMin,
    MOTION_SPRING_BOUNDS.dampingMax,
  );
  return {
    mass: mass ?? MOTION_SPRING_DEFAULTS.mass,
    stiffness: stiffness ?? MOTION_SPRING_DEFAULTS.stiffness,
    damping: damping ?? MOTION_SPRING_DEFAULTS.damping,
  };
};

/**
 * Validate + normalize the raw `options` record for one primitive.
 * Unknown keys, wrong types, out-of-range values, missing required
 * combinations, and inapplicable options all become MOTION_INVALID_OPTION
 * issues; defaults are filled here so the compiler is total.
 */
export const parseMotionOptions = (
  primitive: MotionPrimitive,
  raw: unknown,
  issues: MotionIssue[],
): NormalizedMotionOptions => {
  const options: NormalizedMotionOptions = {};
  if (raw === undefined || raw === null) {
    // still fall through to required-combination checks with an empty record
  } else if (typeof raw !== 'object' || Array.isArray(raw)) {
    addIssue(
      issues,
      'options',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      'options must be an object',
    );
    return options;
  }
  const record: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const allowedKeys = MOTION_OPTION_KEYS[primitive];
  const keys = Object.keys(record);
  if (keys.length > MOTION_MAX_OPTION_KEYS) {
    addIssue(
      issues,
      'options',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `options accepts at most ${MOTION_MAX_OPTION_KEYS} keys`,
    );
  }
  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      addIssue(
        issues,
        `options.${key}`,
        MOTION_ISSUE_CODES.INVALID_OPTION,
        `unknown option "${key}" for primitive "${primitive}"; allowed: ${listValues(allowedKeys)}`,
      );
    }
  }

  if (record.easing !== undefined) {
    if (typeof record.easing !== 'string' || !isEasingName(record.easing)) {
      addIssue(
        issues,
        'options.easing',
        MOTION_ISSUE_CODES.INVALID_OPTION,
        'options.easing must be a named timeline easing (linear, easeIn, easeOut, easeInOut, easeInQuad, easeOutQuad, easeInCubic, easeOutCubic, easeInBack, easeOutBack)',
      );
    } else {
      options.easing = record.easing;
    }
  }
  options.spring = parseSpring(primitive, record.spring, issues);

  const in01 = (key: string): number | undefined =>
    numberOption(record, key, 0, 1, issues);
  const scaleFactor = (key: string): number | undefined =>
    numberOption(record, key, 0, MOTION_MAX_SCALE_FACTOR, issues);

  switch (primitive) {
    case 'fadeIn':
      options.from = in01('from') ?? 0;
      break;
    case 'popIn':
      options.from = scaleFactor('from') ?? 0;
      break;
    case 'scaleIn':
      options.from = scaleFactor('from') ?? 0.5;
      break;
    case 'fadeOut':
      options.to = in01('to') ?? 0;
      break;
    case 'scaleOut':
      options.to = scaleFactor('to') ?? 0;
      break;
    case 'fade': {
      const from = in01('from');
      const to = in01('to');
      if (from === undefined && to === undefined && (record.from !== undefined || record.to !== undefined)) {
        break; // both invalid — already reported
      }
      if (record.from === undefined && record.to === undefined) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'fade requires options.from and/or options.to (0 to 1)',
        );
      }
      if (from !== undefined) options.from = from;
      if (to !== undefined) options.to = to;
      break;
    }
    case 'slideIn':
    case 'slideOut': {
      options.direction = enumOption(record, 'direction', MOTION_DIRECTIONS, issues) ?? 'bottom';
      const distance = numberOption(record, 'distance', 0.01, MOTION_MAX_DISTANCE, issues);
      if (distance !== undefined) options.distance = distance;
      break;
    }
    case 'move': {
      const dx = numberOption(record, 'dx', -MOTION_MAX_DISTANCE, MOTION_MAX_DISTANCE, issues);
      const dy = numberOption(record, 'dy', -MOTION_MAX_DISTANCE, MOTION_MAX_DISTANCE, issues);
      if (record.dx === undefined && record.dy === undefined) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'move requires options.dx and/or options.dy',
        );
        break;
      }
      if ((dx ?? 0) === 0 && (dy ?? 0) === 0) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'move requires at least one non-zero delta',
        );
        break;
      }
      if (dx !== undefined) options.dx = dx;
      if (dy !== undefined) options.dy = dy;
      break;
    }
    case 'scale': {
      const factor = scaleFactor('factor');
      const factorX = scaleFactor('factorX');
      const factorY = scaleFactor('factorY');
      if (
        record.factor === undefined &&
        record.factorX === undefined &&
        record.factorY === undefined
      ) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'scale requires options.factor, options.factorX, and/or options.factorY',
        );
        break;
      }
      const effectiveX = factorX ?? factor ?? 1;
      const effectiveY = factorY ?? factor ?? 1;
      if (effectiveX === 1 && effectiveY === 1) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'scale must change at least one axis (factor must differ from 1)',
        );
        break;
      }
      if (factor !== undefined) options.factor = factor;
      if (factorX !== undefined) options.factorX = factorX;
      if (factorY !== undefined) options.factorY = factorY;
      break;
    }
    case 'resize': {
      const width = numberOption(record, 'width', 0.01, MOTION_MAX_RESIZE, issues);
      const height = numberOption(record, 'height', 0.01, MOTION_MAX_RESIZE, issues);
      if (record.width === undefined && record.height === undefined) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'resize requires options.width and/or options.height',
        );
        break;
      }
      if (width !== undefined) options.width = width;
      if (height !== undefined) options.height = height;
      break;
    }
    case 'rotate': {
      if (record.degrees === undefined && record.cycles === undefined) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'rotate requires options.degrees or options.cycles',
        );
        break;
      }
      if (record.degrees !== undefined && record.cycles !== undefined) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'rotate accepts either options.degrees or options.cycles, not both',
        );
        break;
      }
      if (record.degrees !== undefined) {
        const degrees = numberOption(
          record,
          'degrees',
          -MOTION_MAX_ROTATE_DEGREES,
          MOTION_MAX_ROTATE_DEGREES,
          issues,
        );
        if (degrees !== undefined) {
          if (degrees === 0) {
            addIssue(
              issues,
              'options.degrees',
              MOTION_ISSUE_CODES.INVALID_OPTION,
              'rotate degrees must be non-zero',
            );
          } else {
            options.degrees = degrees;
          }
        }
      } else {
        const cycles = integerOption(record, 'cycles', -MOTION_MAX_ROTATE_CYCLES, MOTION_MAX_ROTATE_CYCLES, issues);
        if (cycles !== undefined) {
          if (cycles === 0) {
            addIssue(
              issues,
              'options.cycles',
              MOTION_ISSUE_CODES.INVALID_OPTION,
              'rotate cycles must be non-zero',
            );
          } else {
            options.cycles = cycles;
          }
        }
      }
      break;
    }
    case 'pulse': {
      const factor = scaleFactor('factor') ?? 1.08;
      const cycles = integerOption(record, 'cycles', 1, MOTION_MAX_CYCLES, issues) ?? 1;
      if (factor === 1) {
        addIssue(
          issues,
          'options.factor',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'pulse factor must differ from 1',
        );
      }
      options.factor = factor;
      options.cycles = cycles;
      break;
    }
    case 'scaleEmphasis': {
      const factor = scaleFactor('factor') ?? 1.15;
      if (factor === 1) {
        addIssue(
          issues,
          'options.factor',
          MOTION_ISSUE_CODES.INVALID_OPTION,
          'scaleEmphasis factor must differ from 1',
        );
      }
      options.factor = factor;
      break;
    }
    case 'bounce': {
      const height = numberOption(record, 'height', 0.01, MOTION_MAX_BOUNCE_HEIGHT, issues);
      if (height !== undefined) options.height = height;
      options.cycles = integerOption(record, 'cycles', 1, MOTION_MAX_CYCLES, issues) ?? 1;
      break;
    }
    case 'shake': {
      const distance = numberOption(record, 'distance', 0.01, MOTION_MAX_SHAKE_DISTANCE, issues);
      options.distance = distance ?? 6;
      options.cycles = integerOption(record, 'cycles', 1, MOTION_MAX_CYCLES, issues) ?? 3;
      options.axis = enumOption(record, 'axis', MOTION_AXES, issues) ?? 'x';
      break;
    }
  }
  return options;
};

// ---------------------------------------------------------------------------
// Primitive → animatable properties (geometry-free; drives conflict checks)
// ---------------------------------------------------------------------------

export const motionPropertiesFor = (
  primitive: MotionPrimitive,
  options: NormalizedMotionOptions,
): AnimatableProperty[] => {
  switch (primitive) {
    case 'fadeIn':
    case 'fadeOut':
    case 'fade':
      return ['style.opacity'];
    case 'scaleIn':
    case 'popIn':
    case 'scaleOut':
    case 'scale':
    case 'pulse':
    case 'scaleEmphasis':
      return ['transform.scaleX', 'transform.scaleY'];
    case 'slideIn':
    case 'slideOut': {
      const direction = options.direction ?? 'bottom';
      return direction === 'left' || direction === 'right'
        ? ['position.x']
        : ['position.y'];
    }
    case 'move': {
      const properties: AnimatableProperty[] = [];
      if ((options.dx ?? 0) !== 0) properties.push('position.x');
      if ((options.dy ?? 0) !== 0) properties.push('position.y');
      return properties;
    }
    case 'resize': {
      const properties: AnimatableProperty[] = [];
      if (options.width !== undefined) properties.push('size.width');
      if (options.height !== undefined) properties.push('size.height');
      return properties;
    }
    case 'rotate':
      return ['transform.rotation'];
    case 'bounce':
      return ['position.y'];
    case 'shake': {
      const axis = options.axis ?? 'x';
      if (axis === 'both') return ['position.x', 'position.y'];
      return axis === 'x' ? ['position.x'] : ['position.y'];
    }
  }
};

const defaultEasingFor = (
  primitive: MotionPrimitive,
  options: NormalizedMotionOptions,
): EasingName => {
  if (options.easing) return options.easing;
  switch (primitive) {
    case 'fadeIn':
    case 'scaleIn':
    case 'slideIn':
      return 'easeOut';
    case 'popIn':
      return 'easeOutBack';
    case 'fadeOut':
    case 'scaleOut':
    case 'slideOut':
      return 'easeIn';
    case 'rotate':
      // Continuous (multi-cycle) rotation reads as mechanical motion.
      return options.cycles !== undefined ? 'linear' : 'easeInOut';
    case 'move':
    case 'scale':
    case 'resize':
    case 'fade':
      return 'easeInOut';
    case 'pulse':
    case 'scaleEmphasis':
      return 'easeInOut';
    case 'bounce':
      return 'easeInOut';
    case 'shake':
      return 'linear';
  }
};

// ---------------------------------------------------------------------------
// Spring (closed-form damped harmonic oscillator, sampled into keyframes)
// ---------------------------------------------------------------------------

/**
 * Position of a unit spring from 0 → 1 at time t with x(0)=0, x'(0)=0.
 * Closed form (under/critical/over damped) — pure math, so `@app/render`
 * stays dependency-free (no Remotion `spring()`, which only exists in the
 * legacy VideoSpec composition) and output is byte-identical everywhere.
 */
export const springProgress = (
  t: number,
  spring: { mass: number; stiffness: number; damping: number },
): number => {
  if (!Number.isFinite(t) || t <= 0) return 0;
  const { mass, stiffness, damping } = spring;
  if (!(mass > 0) || !(stiffness > 0)) return clamp01(t);
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    if (!(wd > 0)) return clamp01(t);
    return (
      1 -
      Math.exp(-zeta * w0 * t) *
        (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    );
  }
  if (zeta === 1) {
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  const denominator = r2 - r1;
  if (!Number.isFinite(denominator) || denominator === 0) return clamp01(t);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / denominator;
};

const springKeyframes = (
  from: number,
  to: number,
  input: { startFrame: number; endFrame: number; fps: number },
  spring: { mass: number; stiffness: number; damping: number },
): TimelineKeyframe[] => {
  const span = input.endFrame - input.startFrame;
  const samples = Math.max(1, Math.min(MOTION_SPRING_MAX_SAMPLES, span));
  const keyframes: TimelineKeyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const frame = input.startFrame + Math.round((i * span) / samples);
    // The final sample is forced onto the target so a spring always settles
    // exactly on its endpoint value at the window end (documented).
    const value =
      i === samples ? to : from + (to - from) * springProgress((frame - input.startFrame) / input.fps, spring);
    keyframes.push({ frame, value: round2(value), easing: 'linear' });
  }
  return keyframes;
};

// ---------------------------------------------------------------------------
// Compile request / result
// ---------------------------------------------------------------------------

export interface MotionBaseValues {
  position: { x: number; y: number };
  size: { width: number; height: number };
  transform: { rotation: number; scaleX: number; scaleY: number };
  style: { opacity: number };
}

export interface MotionTrackLike {
  property: string;
  keyframes: Array<{ frame: number; value: number; easing?: string }>;
}

export interface MotionTargetInput {
  id: string;
  /** Authoritative document base values (never the animated values). */
  base: MotionBaseValues;
  /** Stored tracks for this instance (merged, never discarded outside windows). */
  existingTracks?: MotionTrackLike[] | null;
}

export interface MotionCompileRequest {
  primitive: string;
  options?: Record<string, unknown> | null;
  timing?: MotionTimingInput | null;
  choreography?: MotionChoreographyInput | null;
  /** Resolved targets in choreography order (plan refs first, then group members). */
  targets: MotionTargetInput[];
  timeline?: { fps?: unknown; durationFrames?: unknown } | null;
  /** Canvas for derived slide distances; defaults to the canonical WORLD box. */
  canvas?: { width: number; height: number } | null;
}

export interface CompiledMotionWindow {
  property: AnimatableProperty;
  startFrame: number;
  endFrame: number;
}

export interface CompiledMotionTarget {
  id: string;
  /** Full merged track set for the instance (existing ± motion windows). */
  tracks: AnimationTrack[];
  windows: CompiledMotionWindow[];
}

export interface CompiledMotion {
  /** Present only when the primitive was supported and options parsed cleanly. */
  primitive?: MotionPrimitive;
  targets: CompiledMotionTarget[];
  issues: MotionIssue[];
}

interface BuildContext {
  base: MotionBaseValues;
  bounds: RenderBounds;
  canvas: { width: number; height: number };
  options: NormalizedMotionOptions;
  easing: EasingName;
  startFrame: number;
  endFrame: number;
  fps: number;
}

type BuiltTracks = Partial<Record<AnimatableProperty, TimelineKeyframe[]>>;

const deriveSlideDistance = (
  bounds: RenderBounds,
  direction: MotionDirection,
  canvas: { width: number; height: number },
  options: NormalizedMotionOptions,
): number => {
  if (options.distance !== undefined) return options.distance;
  const raw =
    direction === 'left'
      ? bounds.x
      : direction === 'right'
        ? canvas.width - (bounds.x + bounds.width)
        : direction === 'top'
          ? bounds.y
          : canvas.height - (bounds.y + bounds.height);
  return clamp(raw, MOTION_MIN_DERIVED_DISTANCE, MOTION_MAX_DISTANCE);
};

/** Single-segment keyframes (or sampled spring) from → to. */
const segment = (
  from: number,
  to: number,
  ctx: BuildContext,
  easing: EasingName,
): TimelineKeyframe[] => {
  if (round2(from) === round2(to)) return [];
  if (ctx.options.spring) {
    return springKeyframes(
      from,
      to,
      { startFrame: ctx.startFrame, endFrame: ctx.endFrame, fps: ctx.fps },
      ctx.options.spring,
    );
  }
  return [
    { frame: ctx.startFrame, value: round2(from), easing },
    { frame: ctx.endFrame, value: round2(to), easing: 'linear' },
  ];
};

/**
 * Multi-segment emphasis pattern over the window: frames split evenly into
 * `segments` spans, values come from `valueAt(k)` (k = 0 and k = segments
 * are the endpoints), and the final keyframe lands exactly on the window
 * end so every emphasis returns to its endpoint value.
 */
const patternKeyframes = (
  segments: number,
  valueAt: (k: number) => number,
  easingFor: (segmentIndex: number) => EasingName,
  ctx: BuildContext,
): TimelineKeyframe[] => {
  if (segments < 1) return [];
  const values = Array.from({ length: segments + 1 }, (_, k) => round2(valueAt(k)));
  if (values.every((value) => value === values[0])) return [];
  const keyframes: TimelineKeyframe[] = [];
  for (let k = 0; k <= segments; k++) {
    const frame = ctx.startFrame + Math.round((k * (ctx.endFrame - ctx.startFrame)) / segments);
    keyframes.push({
      frame,
      value: values[k],
      easing: k === segments ? 'linear' : easingFor(k),
    });
  }
  return keyframes;
};

/** base → alternate → base … alternation used by pulse/scaleEmphasis/bounce. */
const emphasisKeyframes = (
  baseValue: number,
  alternateValue: number,
  segments: number,
  easingFor: (segmentIndex: number) => EasingName,
  ctx: BuildContext,
): TimelineKeyframe[] =>
  patternKeyframes(
    segments,
    (k) => (k === 0 || k === segments || k % 2 === 0 ? baseValue : alternateValue),
    easingFor,
    ctx,
  );

const buildTracks = (
  primitive: MotionPrimitive,
  ctx: BuildContext,
): BuiltTracks => {
  const { base, bounds, canvas, options, easing } = ctx;
  const tracks: BuiltTracks = {};
  const set = (property: AnimatableProperty, keyframes: TimelineKeyframe[]): void => {
    if (keyframes.length > 0) tracks[property] = keyframes;
  };
  const opacity = (value: number): number => round2(clamp01(value));

  switch (primitive) {
    case 'fadeIn':
      set('style.opacity', segment(opacity(options.from ?? 0), opacity(base.style.opacity), ctx, easing));
      break;
    case 'fadeOut':
      set('style.opacity', segment(opacity(base.style.opacity), opacity(options.to ?? 0), ctx, easing));
      break;
    case 'fade':
      set(
        'style.opacity',
        segment(
          opacity(options.from ?? base.style.opacity),
          opacity(options.to ?? base.style.opacity),
          ctx,
          easing,
        ),
      );
      break;
    case 'scaleIn':
    case 'popIn': {
      const from = options.from ?? (primitive === 'scaleIn' ? 0.5 : 0);
      set('transform.scaleX', segment(base.transform.scaleX * from, base.transform.scaleX, ctx, easing));
      set('transform.scaleY', segment(base.transform.scaleY * from, base.transform.scaleY, ctx, easing));
      break;
    }
    case 'scaleOut':
      set(
        'transform.scaleX',
        segment(base.transform.scaleX, base.transform.scaleX * (options.to ?? 0), ctx, easing),
      );
      set(
        'transform.scaleY',
        segment(base.transform.scaleY, base.transform.scaleY * (options.to ?? 0), ctx, easing),
      );
      break;
    case 'scale': {
      const factorX = options.factorX ?? options.factor ?? 1;
      const factorY = options.factorY ?? options.factor ?? 1;
      if (factorX !== 1) {
        set('transform.scaleX', segment(base.transform.scaleX, base.transform.scaleX * factorX, ctx, easing));
      }
      if (factorY !== 1) {
        set('transform.scaleY', segment(base.transform.scaleY, base.transform.scaleY * factorY, ctx, easing));
      }
      break;
    }
    case 'slideIn': {
      const direction = options.direction ?? 'bottom';
      const distance = deriveSlideDistance(bounds, direction, canvas, options);
      if (direction === 'left') {
        set('position.x', segment(base.position.x - distance, base.position.x, ctx, easing));
      } else if (direction === 'right') {
        set('position.x', segment(base.position.x + distance, base.position.x, ctx, easing));
      } else if (direction === 'top') {
        set('position.y', segment(base.position.y - distance, base.position.y, ctx, easing));
      } else {
        set('position.y', segment(base.position.y + distance, base.position.y, ctx, easing));
      }
      break;
    }
    case 'slideOut': {
      const direction = options.direction ?? 'bottom';
      const distance = deriveSlideDistance(bounds, direction, canvas, options);
      if (direction === 'left') {
        set('position.x', segment(base.position.x, base.position.x - distance, ctx, easing));
      } else if (direction === 'right') {
        set('position.x', segment(base.position.x, base.position.x + distance, ctx, easing));
      } else if (direction === 'top') {
        set('position.y', segment(base.position.y, base.position.y - distance, ctx, easing));
      } else {
        set('position.y', segment(base.position.y, base.position.y + distance, ctx, easing));
      }
      break;
    }
    case 'move':
      if ((options.dx ?? 0) !== 0) {
        set('position.x', segment(base.position.x, base.position.x + (options.dx ?? 0), ctx, easing));
      }
      if ((options.dy ?? 0) !== 0) {
        set('position.y', segment(base.position.y, base.position.y + (options.dy ?? 0), ctx, easing));
      }
      break;
    case 'resize':
      if (options.width !== undefined) {
        set('size.width', segment(base.size.width, options.width, ctx, easing));
      }
      if (options.height !== undefined) {
        set('size.height', segment(base.size.height, options.height, ctx, easing));
      }
      break;
    case 'rotate': {
      const total =
        options.degrees !== undefined
          ? options.degrees
          : (options.cycles ?? 0) * 360;
      set('transform.rotation', segment(base.transform.rotation, base.transform.rotation + total, ctx, easing));
      break;
    }
    case 'pulse': {
      const factor = options.factor ?? 1.08;
      const cycles = options.cycles ?? 1;
      const segmentEasing = options.easing ?? 'easeInOut';
      set(
        'transform.scaleX',
        emphasisKeyframes(
          base.transform.scaleX,
          base.transform.scaleX * factor,
          cycles * 2,
          () => segmentEasing,
          ctx,
        ),
      );
      set(
        'transform.scaleY',
        emphasisKeyframes(
          base.transform.scaleY,
          base.transform.scaleY * factor,
          cycles * 2,
          () => segmentEasing,
          ctx,
        ),
      );
      break;
    }
    case 'scaleEmphasis': {
      const factor = options.factor ?? 1.15;
      const segmentEasing = options.easing ?? 'easeInOut';
      set(
        'transform.scaleX',
        emphasisKeyframes(
          base.transform.scaleX,
          base.transform.scaleX * factor,
          2,
          () => segmentEasing,
          ctx,
        ),
      );
      set(
        'transform.scaleY',
        emphasisKeyframes(
          base.transform.scaleY,
          base.transform.scaleY * factor,
          2,
          () => segmentEasing,
          ctx,
        ),
      );
      break;
    }
    case 'bounce': {
      const height =
        options.height ?? clamp(bounds.height, MOTION_MIN_DERIVED_DISTANCE, MOTION_MAX_BOUNCE_HEIGHT);
      const cycles = options.cycles ?? 1;
      // Rise decelerates (easeOut), fall accelerates (easeIn); an explicit
      // easing option overrides both segments.
      const segmentEasing = (k: number): EasingName =>
        options.easing ?? (k % 2 === 0 ? 'easeOut' : 'easeIn');
      set(
        'position.y',
        emphasisKeyframes(
          base.position.y,
          base.position.y - height,
          cycles * 2,
          segmentEasing,
          ctx,
        ),
      );
      break;
    }
    case 'shake': {
      const distance = options.distance ?? 6;
      const cycles = options.cycles ?? 3;
      const axis = options.axis ?? 'x';
      const segmentEasing = options.easing ?? 'linear';
      const segments = cycles * 2;
      // Shake alternates +distance / -distance between the endpoints
      // (base → +d → -d → … → base), unlike pulse/bounce which toggle one
      // alternate value.
      const shakeValue = (baseValue: number) => (k: number): number => {
        if (k === 0 || k === segments) return baseValue;
        return k % 2 === 1 ? baseValue + distance : baseValue - distance;
      };
      if (axis === 'x' || axis === 'both') {
        set(
          'position.x',
          patternKeyframes(segments, shakeValue(base.position.x), () => segmentEasing, ctx),
        );
      }
      if (axis === 'y' || axis === 'both') {
        set(
          'position.y',
          patternKeyframes(segments, shakeValue(base.position.y), () => segmentEasing, ctx),
        );
      }
      break;
    }
  }
  return tracks;
};

// ---------------------------------------------------------------------------
// Merge (window ownership)
// ---------------------------------------------------------------------------

/**
 * Merge compiled motion tracks into an instance's existing tracks.
 * Keyframes with frame inside the motion window [start, end] are replaced;
 * everything outside is preserved; the result is normalized (sorted,
 * deduped keeping last, non-finite dropped) exactly like the evaluator
 * normalizes hand-authored tracks. Existing non-animatable/unknown property
 * entries are kept untouched.
 */
export const mergeMotionTracks = (
  existing: readonly MotionTrackLike[] | null | undefined,
  compiled: readonly AnimationTrack[],
  windows: readonly CompiledMotionWindow[],
): AnimationTrack[] => {
  const windowByProperty = new Map<string, CompiledMotionWindow>();
  for (const window of windows) windowByProperty.set(window.property, window);
  const compiledByProperty = new Map<string, TimelineKeyframe[]>();
  for (const track of compiled) compiledByProperty.set(track.property, track.keyframes);

  const result: AnimationTrack[] = [];
  const handled = new Set<string>();

  for (const track of existing ?? []) {
    if (!track || typeof track.property !== 'string') continue;
    const window = windowByProperty.get(track.property);
    const compiledKeyframes = compiledByProperty.get(track.property);
    if (window && compiledKeyframes) {
      handled.add(track.property);
      const outside = (track.keyframes ?? []).filter(
        (keyframe) =>
          typeof keyframe?.frame === 'number' &&
          (keyframe.frame < window.startFrame || keyframe.frame > window.endFrame),
      );
      result.push({
        property: track.property as AnimatableProperty,
        keyframes: normalizeKeyframes([
          ...(outside as TimelineKeyframe[]),
          ...compiledKeyframes,
        ]),
      });
    } else if (!handled.has(track.property)) {
      result.push({
        property: track.property as AnimatableProperty,
        keyframes: normalizeKeyframes(track.keyframes as TimelineKeyframe[]),
      });
    }
  }
  for (const track of compiled) {
    if (handled.has(track.property)) continue;
    result.push({
      property: track.property,
      keyframes: normalizeKeyframes(track.keyframes),
    });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface MotionPlanItem {
  opIndex: number;
  targetId: string;
  property: AnimatableProperty;
  startFrame: number;
  endFrame: number;
}

export interface MotionRawKeyframeOp {
  opIndex: number;
  type: string;
  targetId: string;
  property: string;
  frames: number[];
}

/** Strict interior overlap: windows may touch at one boundary frame. */
export const motionWindowsOverlap = (
  a: { startFrame: number; endFrame: number },
  b: { startFrame: number; endFrame: number },
): boolean => a.startFrame < b.endFrame && b.startFrame < a.endFrame;

/**
 * Order-independent conflict detection over the motion items of ONE plan:
 *   - motion vs motion: same target + property with overlapping windows;
 *   - motion vs raw keyframe ops: a raw frame inside a motion window
 *     (inclusive — the motion owns both endpoint frames).
 * Callers pass items accumulated as ops are validated plus a pre-scan of
 * raw keyframe ops, so both argument orders surface the same conflicts.
 */
export const findMotionConflicts = (input: {
  items: readonly MotionPlanItem[];
  priorItems?: readonly MotionPlanItem[];
  rawOps?: readonly MotionRawKeyframeOp[];
}): MotionIssue[] => {
  const issues: MotionIssue[] = [];
  const prior = input.priorItems ?? [];
  for (const item of input.items) {
    for (const other of prior) {
      if (
        other.targetId === item.targetId &&
        other.property === item.property &&
        motionWindowsOverlap(item, other)
      ) {
        addIssue(
          issues,
          'timing',
          MOTION_ISSUE_CODES.CONFLICT,
          `motion op ${item.opIndex} window [${item.startFrame}, ${item.endFrame}] overlaps motion op ${other.opIndex} window [${other.startFrame}, ${other.endFrame}] on ${item.targetId} property ${item.property}; retime one of them or merge them into a single motion operation`,
        );
      }
    }
    for (const raw of input.rawOps ?? []) {
      if (raw.targetId !== item.targetId || raw.property !== item.property) continue;
      const inside = raw.frames.find(
        (frame) => frame >= item.startFrame && frame <= item.endFrame,
      );
      if (inside !== undefined) {
        addIssue(
          issues,
          'timing',
          MOTION_ISSUE_CODES.CONFLICT,
          `motion op ${item.opIndex} window [${item.startFrame}, ${item.endFrame}] collides with ${raw.type} op ${raw.opIndex} frame ${inside} on ${item.targetId} property ${item.property}; motion owns every keyframe inside its window — move the raw frame outside [${item.startFrame}, ${item.endFrame}]`,
        );
      }
    }
  }
  return issues;
};

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * Shared parse/schedule phase: primitive gating, options, timing,
 * choreography, per-target windows (scene-checked), and the primitive's
 * property set. Used by both compilation and conflict planning so conflict
 * detection is value-independent (never depends on which keyframes a
 * particular base geometry happens to emit).
 */
interface ResolvedMotionPlan {
  primitive: MotionPrimitive | null;
  options: NormalizedMotionOptions;
  timing: MotionTimingFrames;
  timeline: { fps: number; durationFrames: number };
  canvas: { width: number; height: number };
  properties: AnimatableProperty[];
  windows: Array<{ target: MotionTargetInput; startFrame: number; endFrame: number }>;
  issues: MotionIssue[];
  ok: boolean;
}

const resolveMotionPlan = (request: MotionCompileRequest): ResolvedMotionPlan => {
  const issues: MotionIssue[] = [];
  const timeline = resolveTimeline({ timeline: request.timeline ?? undefined });
  const canvas =
    request.canvas &&
    Number.isFinite(request.canvas.width) &&
    Number.isFinite(request.canvas.height) &&
    request.canvas.width > 0 &&
    request.canvas.height > 0
      ? { width: request.canvas.width, height: request.canvas.height }
      : { width: WORLD.width, height: WORLD.height };

  const unsupported = (): ResolvedMotionPlan => {
    const primitive = request.primitive;
    if (isDeclaredMotionPrimitive(primitive)) {
      addIssue(
        issues,
        'primitive',
        MOTION_ISSUE_CODES.UNSUPPORTED_RENDER_CAPABILITY,
        `primitive "${primitive}" requires a render capability this pipeline does not have (no masks, blur filters, text reveal, stroke drawing, or camera viewport); it is rejected instead of being faked. Supported primitives: ${listValues(MOTION_PRIMITIVES)}`,
      );
    } else {
      addIssue(
        issues,
        'primitive',
        MOTION_ISSUE_CODES.UNSUPPORTED_PRIMITIVE,
        `unknown motion primitive "${String(primitive).slice(0, 40)}"; supported primitives: ${listValues(MOTION_PRIMITIVES)}`,
      );
    }
    return {
      primitive: null,
      options: {},
      timing: { startFrame: 0, delayFrames: 0, durationFrames: 1, durationSeconds: 1 },
      timeline,
      canvas,
      properties: [],
      windows: [],
      issues,
      ok: false,
    };
  };

  if (!isMotionPrimitiveSupported(request.primitive)) return unsupported();
  const primitive = request.primitive;
  const options = parseMotionOptions(primitive, request.options ?? undefined, issues);
  const timing = resolveMotionTiming(request.timing ?? undefined, timeline, issues);
  const choreography = resolveMotionChoreography(request.choreography ?? undefined, issues);

  if (request.targets.length === 0) {
    addIssue(
      issues,
      'targets',
      MOTION_ISSUE_CODES.TARGET_NOT_FOUND,
      'motion requires at least one resolved target',
    );
  }

  // Schedule: rank → offset → per-target window (checked against the scene).
  const ranks = motionRanks(request.targets.length, choreography.order);
  const windows: ResolvedMotionPlan['windows'] = [];
  if (timing) {
    request.targets.forEach((target, index) => {
      const offsetSeconds = motionOffsetSeconds(ranks[index], choreography, timing.durationSeconds);
      const startFrame =
        timing.startFrame +
        timing.delayFrames +
        Math.max(0, Math.round(offsetSeconds * timeline.fps));
      const endFrame = startFrame + timing.durationFrames;
      if (endFrame > timeline.durationFrames) {
        addIssue(
          issues,
          'timing',
          MOTION_ISSUE_CODES.INVALID_TIMING,
          `motion window for target ${target.id} ends at frame ${endFrame}, beyond the scene duration (${timeline.durationFrames} frames); reduce the duration, stagger, or target count`,
        );
        return;
      }
      windows.push({ target, startFrame, endFrame });
    });
  }

  const properties =
    issues.length === 0 && timing ? motionPropertiesFor(primitive, options) : [];
  if (issues.length === 0 && timing && properties.length === 0) {
    addIssue(
      issues,
      'options',
      MOTION_ISSUE_CODES.INVALID_OPTION,
      `primitive "${primitive}" resolved to no animatable properties`,
    );
  }

  const ok = issues.length === 0 && timing !== null && properties.length > 0;
  return {
    primitive,
    options,
    timing: timing ?? { startFrame: 0, delayFrames: 0, durationFrames: 1, durationSeconds: 1 },
    timeline,
    canvas,
    properties,
    windows,
    issues,
    ok,
  };
};

/**
 * Planned windows for conflict detection: one item per (target, property)
 * with the choreography-shifted window, independent of emitted values.
 * Callers pair this with `findMotionConflicts`.
 */
export const planMotionWindows = (
  request: MotionCompileRequest,
): { items: MotionPlanItem[]; issues: MotionIssue[] } => {
  const plan = resolveMotionPlan(request);
  const items: MotionPlanItem[] = [];
  if (plan.ok && plan.primitive !== null) {
    for (const window of plan.windows) {
      for (const property of plan.properties) {
        items.push({
          opIndex: 0,
          targetId: window.target.id,
          property,
          startFrame: window.startFrame,
          endFrame: window.endFrame,
        });
      }
    }
  }
  return { items, issues: plan.issues };
};

/**
 * Compile motion intent into merged animation tracks for every target.
 * Total: invalid input produces MOTION_* issues and an empty target list —
 * the engine never throws and never emits non-finite values.
 */
export const compileMotion = (request: MotionCompileRequest): CompiledMotion => {
  const plan = resolveMotionPlan(request);
  const issues = plan.issues;
  if (!plan.ok || plan.primitive === null) return { targets: [], issues };
  const { primitive, options, properties, windows, timeline, canvas } = plan;

  const targets: CompiledMotionTarget[] = [];
  for (const window of windows) {
    const base: MotionBaseValues = {
      position: {
        x: toFinite(window.target.base?.position?.x, 0),
        y: toFinite(window.target.base?.position?.y, 0),
      },
      size: {
        width: toFinite(window.target.base?.size?.width, 100),
        height: toFinite(window.target.base?.size?.height, 100),
      },
      transform: {
        rotation: toFinite(window.target.base?.transform?.rotation, 0),
        scaleX: toFinite(window.target.base?.transform?.scaleX, 1),
        scaleY: toFinite(window.target.base?.transform?.scaleY, 1),
      },
      style: { opacity: toFinite(window.target.base?.style?.opacity, 1) },
    };
    const ctx: BuildContext = {
      base,
      bounds: boundsOf({ position: base.position, size: base.size }),
      canvas,
      options,
      easing: defaultEasingFor(primitive, options),
      startFrame: window.startFrame,
      endFrame: window.endFrame,
      fps: timeline.fps,
    };
    const built = buildTracks(primitive, ctx);
    const compiledTracks: AnimationTrack[] = [];
    const compiledWindows: CompiledMotionWindow[] = [];
    for (const property of properties) {
      const keyframes = built[property];
      if (!keyframes || keyframes.length === 0) continue;
      const normalized = normalizeKeyframes(keyframes);
      if (
        normalized.some(
          (keyframe) =>
            !Number.isFinite(keyframe.value) ||
            keyframe.frame < 0 ||
            keyframe.frame > timeline.durationFrames,
        )
      ) {
        addIssue(
          issues,
          'options',
          MOTION_ISSUE_CODES.COMPILATION_ERROR,
          `primitive "${primitive}" produced an out-of-range value for ${property} on ${window.target.id}`,
        );
        continue;
      }
      compiledTracks.push({ property, keyframes: normalized });
      compiledWindows.push({
        property,
        startFrame: window.startFrame,
        endFrame: window.endFrame,
      });
    }
    if (compiledTracks.length === 0) continue;
    targets.push({
      id: window.target.id,
      tracks: mergeMotionTracks(window.target.existingTracks, compiledTracks, compiledWindows),
      windows: compiledWindows,
    });
  }

  return { primitive, targets, issues };
};

// ---------------------------------------------------------------------------
// Verification (application-side; the model cannot self-declare success)
// ---------------------------------------------------------------------------

export interface MotionVerificationResult {
  passed: boolean;
  issues: string[];
}

/**
 * Recompile the motion deterministically against the POST-apply document
 * (targets carry the tracks actually stored) and diff stored keyframes
 * against freshly compiled expectations inside every motion window:
 * track existence, frame presence, value agreement within tolerance,
 * finiteness, scene-duration bounds, and opacity ∈ [0,1].
 */
export const verifyMotionApplication = (request: MotionCompileRequest): MotionVerificationResult => {
  const issues: string[] = [];
  const push = (message: string): void => {
    if (issues.length < MOTION_MAX_ISSUES) issues.push(message);
  };
  const compiled = compileMotion(request);
  for (const issue of compiled.issues) {
    push(`${issue.path}: ${issue.message}`);
  }
  const inputById = new Map(request.targets.map((target) => [target.id, target]));
  for (const target of compiled.targets) {
    const input = inputById.get(target.id);
    const stored = new Map<string, TimelineKeyframe[]>();
    for (const track of input?.existingTracks ?? []) {
      if (!isAnimatableProperty(track.property)) continue;
      stored.set(track.property, normalizeKeyframes(track.keyframes as TimelineKeyframe[]));
    }
    for (const window of target.windows) {
      const actualKeyframes = stored.get(window.property);
      if (!actualKeyframes) {
        push(`instance ${target.id}: expected motion track ${window.property} is missing`);
        continue;
      }
      const compiledTrack = target.tracks.find(
        (track) => track.property === window.property,
      );
      const expected = (compiledTrack?.keyframes ?? []).filter(
        (keyframe) =>
          keyframe.frame >= window.startFrame && keyframe.frame <= window.endFrame,
      );
      for (const keyframe of expected) {
        const actual = actualKeyframes.find((k) => k.frame === keyframe.frame);
        if (!actual) {
          push(
            `instance ${target.id}: ${window.property} keyframe at frame ${keyframe.frame} is missing`,
          );
          continue;
        }
        if (!Number.isFinite(actual.value)) {
          push(
            `instance ${target.id}: ${window.property} keyframe at frame ${keyframe.frame} is not a finite number`,
          );
          continue;
        }
        if (Math.abs(actual.value - keyframe.value) > MOTION_VALUE_TOLERANCE) {
          push(
            `instance ${target.id}: ${window.property} keyframe at frame ${keyframe.frame} is ${actual.value}, expected ${keyframe.value} (tolerance ${MOTION_VALUE_TOLERANCE})`,
          );
        }
        if (
          window.property === 'style.opacity' &&
          (actual.value < 0 || actual.value > 1)
        ) {
          push(
            `instance ${target.id}: style.opacity keyframe at frame ${keyframe.frame} is ${actual.value}, outside [0, 1]`,
          );
        }
      }
      for (const keyframe of actualKeyframes) {
        if (
          keyframe.frame >= window.startFrame &&
          keyframe.frame <= window.endFrame &&
          keyframe.frame > timelineDurationFramesOf(request)
        ) {
          push(
            `instance ${target.id}: ${window.property} keyframe at frame ${keyframe.frame} is outside the scene duration`,
          );
        }
      }
    }
  }
  return { passed: issues.length === 0, issues };
};

const timelineDurationFramesOf = (request: MotionCompileRequest): number =>
  resolveTimeline({ timeline: request.timeline ?? undefined }).durationFrames;
