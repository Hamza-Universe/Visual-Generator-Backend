/**
 * Deterministic easing (Stage 3A).
 *
 * Pure functions of t in [0, 1]. No browser, React, Remotion, or DOM APIs.
 * Unknown easing names fall back to linear so evaluation never throws.
 */
import { isEasingName, type EasingName } from './timeline.js';

export const linear = (t: number): number => t;

export const easeIn = (t: number): number => t * t;

export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

export const easeInOut = (t: number): number =>
  t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;

// Stage 4D motion-easing variants. Names are explicit even where the math
// matches a base curve (easeInQuad === easeIn) so models and documents can
// address curves unambiguously. Back easings overshoot mid-range and land
// exactly on 0/1 at the boundaries (c1 = 1.70158, c3 = c1 + 1).
export const easeInQuad = (t: number): number => t * t;

export const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);

export const easeInCubic = (t: number): number => t * t * t;

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;

export const easeInBack = (t: number): number =>
  BACK_C3 * t * t * t - BACK_C1 * t * t;

export const easeOutBack = (t: number): number => {
  const shifted = t - 1;
  return 1 + BACK_C3 * shifted * shifted * shifted + BACK_C1 * shifted * shifted;
};

const EASING_FNS: Record<EasingName, (t: number) => number> = {
  linear,
  easeIn,
  easeOut,
  easeInOut,
  easeInQuad,
  easeOutQuad,
  easeInCubic,
  easeOutCubic,
  easeInBack,
  easeOutBack,
};

const clamp01 = (t: number): number => {
  if (!Number.isFinite(t)) return 0;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
};

/** Evaluate easing `name` at normalized progress `t`. Pure + total. */
export const evaluateEasing = (name: unknown, t: number): number => {
  const key: EasingName = isEasingName(name) ? name : 'linear';
  return EASING_FNS[key](clamp01(t));
};
