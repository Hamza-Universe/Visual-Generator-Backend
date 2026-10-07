/**
 * Deterministic scene evaluator (Stage 3A).
 *
 *   SceneDocument + frame  →  evaluateSceneAtFrame()  →  EvaluatedScene
 *                                                    →  existing render tree
 *
 * Pure and total: no mutation, no I/O, no randomness, no environment APIs.
 * The stored SceneDocument is never modified — evaluation returns new
 * objects with interpolated position/size/transform/style and computed
 * `visible`. Groups, instance IDs, references (ids inside `props`), and
 * document order (z-order input) are preserved untouched.
 */
import { evaluateEasing } from './easing.js';
import {
  isAnimatableProperty,
  normalizeFrame,
  normalizeKeyframes,
  resolveTimeline,
  resolveTimingFrames,
  type AnimatableProperty,
  type AnimationTrack,
  type TimelineDocument,
  type TimelineKeyframe,
} from './timeline.js';
import type { RenderableGroup, RenderableInstance } from './types.js';

export type EvaluatedComponentInstance = RenderableInstance & {
  timing?: { start?: number; duration?: number; startFrame?: number; durationFrames?: number } | null;
  animation?: { tracks?: AnimationTrack[]; [key: string]: unknown } | null;
};

export interface EvaluatedScene {
  /** Resolved canonical timeline used for this evaluation. */
  timeline: { fps: number; durationFrames: number };
  /** Normalized integer frame that was evaluated. */
  frame: number;
  components: EvaluatedComponentInstance[];
  groups: RenderableGroup[];
  [key: string]: unknown;
}

/**
 * Pure keyframe interpolation.
 * - empty → undefined (no override; caller keeps the base value)
 * - before first → first value; after last → last value
 * - between A..B: t = (frame - A.frame) / (B.frame - A.frame),
 *   eased with A.easing, then lerp(A.value, B.value, easedT)
 * - single keyframe → that value for every frame
 * - duplicate frames → last occurrence wins (see normalizeKeyframes)
 * - unsorted input → sorted ascending (deterministic)
 */
export const interpolateKeyframes = (
  keyframes: readonly TimelineKeyframe[] | null | undefined,
  frame: number,
): number | undefined => {
  const sorted = normalizeKeyframes(keyframes);
  if (sorted.length === 0) return undefined;
  if (!Number.isFinite(frame)) return sorted[0].value;
  const f = frame;
  if (f <= sorted[0].frame) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (f >= last.frame) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (f >= a.frame && f <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.value;
      const t = (f - a.frame) / span;
      const eased = evaluateEasing(a.easing ?? 'linear', t);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
};

const toFiniteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clonePosition = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: toFiniteOr(p?.x, 0),
  y: toFiniteOr(p?.y, 0),
});

const cloneSize = (s: { width: number; height: number }): { width: number; height: number } => ({
  width: toFiniteOr(s?.width, 100),
  height: toFiniteOr(s?.height, 100),
});

const cloneTransform = (t: {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}): { rotation: number; scaleX: number; scaleY: number } => ({
  rotation: toFiniteOr(t?.rotation, 0),
  scaleX: toFiniteOr(t?.scaleX, 1),
  scaleY: toFiniteOr(t?.scaleY, 1),
});

const cloneStyle = (s: { opacity?: number; [key: string]: unknown }): {
  opacity: number;
  [key: string]: unknown;
} => {
  const { opacity, ...rest } = s ?? {};
  return { ...rest, opacity: toFiniteOr(opacity, 1) };
};

/** Apply one interpolated value to a cloned instance via property path. */
const applyAnimatedValue = (
  target: {
    position: { x: number; y: number };
    size: { width: number; height: number };
    transform: { rotation: number; scaleX: number; scaleY: number };
    style: { opacity: number; [key: string]: unknown };
  },
  property: AnimatableProperty,
  value: number,
): void => {
  if (!Number.isFinite(value)) return;
  switch (property) {
    case 'position.x':
      target.position.x = value;
      break;
    case 'position.y':
      target.position.y = value;
      break;
    case 'size.width':
      target.size.width = value;
      break;
    case 'size.height':
      target.size.height = value;
      break;
    case 'transform.rotation':
      target.transform.rotation = value;
      break;
    case 'transform.scaleX':
      target.transform.scaleX = value;
      break;
    case 'transform.scaleY':
      target.transform.scaleY = value;
      break;
    case 'style.opacity':
      target.style.opacity = value;
      break;
  }
};

/**
 * Evaluate one instance at a frame. Returns a NEW object; the input is
 * never mutated. Visibility = baseVisible AND in-timing-range, so instances
 * outside their active range stay resolvable (ids/refs stable) but render
 * as hidden. Animation tracks override base values without touching them.
 */
export const evaluateInstanceAtFrame = <
  T extends {
    id: string;
    props: Record<string, unknown>;
    position: { x: number; y: number };
    size: { width: number; height: number };
    transform: { rotation?: number; scaleX?: number; scaleY?: number };
    style: { opacity?: number; [key: string]: unknown };
    visible: boolean;
    zIndex: number;
    groupId?: string | null;
    timing?: { start?: number; duration?: number; startFrame?: number; durationFrames?: number } | null;
    animation?: { tracks?: unknown; [key: string]: unknown } | null;
    [key: string]: unknown;
  },
>(
  instance: T,
  frame: number,
  fps: number,
): EvaluatedComponentInstance & { [key: string]: unknown } => {
  const f = normalizeFrame(frame);
  const { startFrame, endFrame } = resolveTimingFrames(
    (instance.timing as { start?: number; duration?: number; startFrame?: number; durationFrames?: number } | null | undefined) ?? null,
    fps,
  );
  const baseVisible = instance.visible !== false;
  const visible = baseVisible && startFrame <= f && f < endFrame;

  const position = clonePosition(instance.position);
  const size = cloneSize(instance.size);
  const transform = cloneTransform(instance.transform ?? {});
  const style = cloneStyle((instance.style ?? {}) as { opacity?: number; [key: string]: unknown });
  const target = { position, size, transform, style };

  const rawTracks = (instance.animation as { tracks?: unknown } | null | undefined)?.tracks;
  if (Array.isArray(rawTracks)) {
    for (const raw of rawTracks) {
      if (!raw || typeof raw !== 'object') continue;
      const track = raw as { property?: unknown; keyframes?: unknown };
      if (!isAnimatableProperty(track.property)) continue;
      if (!Array.isArray(track.keyframes)) continue;
      const value = interpolateKeyframes(
        track.keyframes as TimelineKeyframe[],
        f,
      );
      if (value === undefined) continue;
      applyAnimatedValue(target, track.property, value);
    }
  }

  const { position: _p, size: _s, transform: _t, style: _st, visible: _v, ...rest } = instance as Record<string, unknown>;
  void _p;
  void _s;
  void _t;
  void _st;
  void _v;
  return {
    ...(rest as Record<string, unknown>),
    id: instance.id,
    props: instance.props,
    position: target.position,
    size: target.size,
    transform: target.transform,
    style: target.style,
    visible,
    zIndex: instance.zIndex,
    groupId: (instance.groupId ?? null) as string | null,
    timing: (instance.timing as EvaluatedComponentInstance['timing']) ?? null,
    animation: (instance.animation as EvaluatedComponentInstance['animation']) ?? null,
  } as EvaluatedComponentInstance & { [key: string]: unknown };
};

/**
 * Evaluate a whole scene at a frame. Pure: preserves document structure,
 * groups, instance IDs, references, and input order; returns new component
 * objects. Feed `result` straight into `buildRenderTree()` / `buildPaintList()`.
 */
export const evaluateSceneAtFrame = <TDoc extends TimelineDocument>(
  document: TDoc,
  frame: number,
): EvaluatedScene & { [key: string]: unknown } => {
  const timeline = resolveTimeline(document);
  const f = normalizeFrame(frame);
  const components = document.components.map((c) =>
    evaluateInstanceAtFrame(c as never, f, timeline.fps),
  );
  const groups: RenderableGroup[] = document.groups.map((g) => ({ ...g }));
  const { components: _c, groups: _g, timeline: _t, ...rest } = document as Record<string, unknown>;
  void _c;
  void _g;
  void _t;
  return {
    ...(rest as Record<string, unknown>),
    timeline: { ...timeline },
    frame: f,
    components,
    groups,
  };
};

/** Convenience alias matching the task's `evaluateSceneAtTime()` naming. */
export const evaluateSceneAtTime = evaluateSceneAtFrame;

export type { AnimatableProperty, AnimationTrack, TimelineKeyframe } from './timeline.js';
