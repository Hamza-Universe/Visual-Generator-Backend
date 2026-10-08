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

const EASING_FNS: Record<EasingName, (t: number) => number> = {
  linear,
  easeIn,
  easeOut,
  easeInOut,
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
