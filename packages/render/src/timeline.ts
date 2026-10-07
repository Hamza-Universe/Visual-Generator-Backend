/**
 * Timeline domain model (Stage 3A).
 *
 * Frames are the canonical time unit. Seconds may appear at UI/API
 * boundaries but never inside the evaluator: fps=30, durationFrames=300
 * means a 10-second scene.
 *
 * Timing boundary convention (inclusive start, exclusive end):
 *   visible  <=>  startFrame <= frame < endFrame
 *   endFrame = startFrame + durationFrames
 * so startFrame=30, durationFrames=60 is visible on frames 30..89.
 *
 * Pure data + pure helpers only. No React, no DOM, no Remotion, no Node
 * APIs — this module runs identically in browsers, the API, and workers.
 * Never mutates its inputs.
 */

export const DEFAULT_FPS = 30;
export const DEFAULT_DURATION_FRAMES = 300;
export const MAX_FPS = 240;
export const MAX_DURATION_FRAMES = 864000;

export interface TimelineMetadata {
  fps: number;
  durationFrames: number;
}

export type EasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export const EASING_NAMES: readonly EasingName[] = [
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
] as const;

export const isEasingName = (value: unknown): value is EasingName =>
  value === 'linear' ||
  value === 'easeIn' ||
  value === 'easeOut' ||
  value === 'easeInOut';

export type AnimatableProperty =
  | 'position.x'
  | 'position.y'
  | 'size.width'
  | 'size.height'
  | 'transform.rotation'
  | 'transform.scaleX'
  | 'transform.scaleY'
  | 'style.opacity';

export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  'position.x',
  'position.y',
  'size.width',
  'size.height',
  'transform.rotation',
  'transform.scaleX',
  'transform.scaleY',
  'style.opacity',
] as const;

export const isAnimatableProperty = (value: unknown): value is AnimatableProperty =>
  typeof value === 'string' &&
  (ANIMATABLE_PROPERTIES as readonly string[]).includes(value);

export interface TimelineKeyframe {
  frame: number;
  value: number;
  easing?: EasingName;
}

export interface AnimationTrack {
  property: AnimatableProperty;
  keyframes: TimelineKeyframe[];
}

/** Legacy seconds-based timing is still accepted for migration. */
export interface ComponentTiming {
  start?: number;
  duration?: number;
  startFrame?: number;
  durationFrames?: number;
}

export interface ComponentAnimation {
  enter?: string[];
  exit?: string[];
  keyframes?: unknown[];
  tracks?: AnimationTrack[];
}

/**
 * Minimal structural input (Stage 3A).
 *
 * Any SceneDocument-like object satisfies this — `@app/schema` documents,
 * frontend `types/api` scenes, and worker test fixtures. Deliberately free
 * of index signatures so plain interfaces stay assignable; extra fields
 * (ids, definition refs, timestamps) flow through evaluation untouched.
 */
export interface TimelineInstance {
  id: string;
  props: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
  transform: { rotation: number; scaleX: number; scaleY: number };
  style: { opacity: number; [key: string]: unknown };
  visible: boolean;
  zIndex: number;
  groupId?: string | null;
  timing?: ComponentTiming | null;
  animation?: ComponentAnimation | null;
}

export interface TimelineGroup {
  id: string;
  parentGroupId?: string | null;
  zIndex: number;
}

export interface TimelineDocument {
  timeline?: TimelineMetadata | null;
  /** Legacy seconds duration (fallback when `timeline` is absent). */
  duration?: number | null;
  components: TimelineInstance[];
  groups: TimelineGroup[];
}

/** Deterministic timeline resolution. Invalid values fall back to defaults. */
export const resolveTimeline = (document: {
  timeline?: { fps?: unknown; durationFrames?: unknown } | null;
  duration?: unknown;
  components?: unknown;
  groups?: unknown;
} | null | undefined): TimelineMetadata => {
  const doc = document ?? {};
  const raw = doc.timeline ?? {};
  const fps =
    typeof raw.fps === 'number' &&
    Number.isInteger(raw.fps) &&
    raw.fps >= 1 &&
    raw.fps <= MAX_FPS
      ? raw.fps
      : DEFAULT_FPS;
  const durationFrames =
    typeof raw.durationFrames === 'number' &&
    Number.isInteger(raw.durationFrames) &&
    raw.durationFrames >= 1 &&
    raw.durationFrames <= MAX_DURATION_FRAMES
      ? raw.durationFrames
      : typeof doc.duration === 'number' &&
          Number.isFinite(doc.duration) &&
          doc.duration > 0
        ? Math.min(
            MAX_DURATION_FRAMES,
            Math.max(1, Math.round(doc.duration * fps)),
          )
        : DEFAULT_DURATION_FRAMES;
  return { fps, durationFrames };
};

/**
 * Deterministic timing resolution. Frame fields win when they are valid
 * integers >= 0; otherwise legacy seconds convert via fps. Missing timing
 * defaults to the full scene (start 0, scene-length duration is applied by
 * the caller — here we fall back to DEFAULT_DURATION_FRAMES).
 */
export const resolveTimingFrames = (
  timing: ComponentTiming | null | undefined,
  fps: number = DEFAULT_FPS,
): { startFrame: number; durationFrames: number; endFrame: number } => {
  const safeFps =
    typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  const t = timing ?? {};
  const startFrame =
    typeof t.startFrame === 'number' &&
    Number.isInteger(t.startFrame) &&
    t.startFrame >= 0
      ? t.startFrame
      : typeof t.start === 'number' && Number.isFinite(t.start) && t.start >= 0
        ? Math.max(0, Math.round(t.start * safeFps))
        : 0;
  const durationFrames =
    typeof t.durationFrames === 'number' &&
    Number.isInteger(t.durationFrames) &&
    t.durationFrames >= 0
      ? t.durationFrames
      : typeof t.duration === 'number' &&
          Number.isFinite(t.duration) &&
          t.duration > 0
        ? Math.max(1, Math.round(t.duration * safeFps))
        : DEFAULT_DURATION_FRAMES;
  return { startFrame, durationFrames, endFrame: startFrame + durationFrames };
};

/** Normalize a requested frame: finite numbers floor to integers, garbage → 0. */
export const normalizeFrame = (frame: unknown): number => {
  if (typeof frame !== 'number' || !Number.isFinite(frame)) return 0;
  return Math.floor(frame);
};

/**
 * Timing visibility (inclusive/exclusive): startFrame <= frame < endFrame.
 * A zero duration is never visible. Out-of-range frames yield false rather
 * than throwing, so boundary frames stay predictable.
 */
export const isFrameVisible = (
  timing: ComponentTiming | null | undefined,
  frame: number,
  fps: number = DEFAULT_FPS,
): boolean => {
  if (!Number.isFinite(frame)) return false;
  const f = Math.floor(frame);
  const { startFrame, endFrame } = resolveTimingFrames(timing, fps);
  return startFrame <= f && f < endFrame;
};

/**
 * Deterministic keyframe normalization: drop non-finite frames/values and
 * negative frames, dedupe duplicate frames keeping the LAST occurrence,
 * then sort ascending by frame. Documented so every renderer agrees.
 */
export const normalizeKeyframes = (
  keyframes: readonly TimelineKeyframe[] | null | undefined,
): TimelineKeyframe[] => {
  if (!Array.isArray(keyframes)) return [];
  const lastByFrame = new Map<number, TimelineKeyframe>();
  for (const kf of keyframes) {
    if (!kf || typeof kf !== 'object') continue;
    const frame = (kf as TimelineKeyframe).frame;
    const value = (kf as TimelineKeyframe).value;
    if (
      typeof frame !== 'number' ||
      !Number.isInteger(frame) ||
      frame < 0 ||
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) {
      continue;
    }
    const easing = (kf as TimelineKeyframe).easing;
    lastByFrame.set(frame, {
      frame,
      value,
      easing: isEasingName(easing) ? easing : 'linear',
    });
  }
  return [...lastByFrame.values()].sort((a, b) => a.frame - b.frame);
};
