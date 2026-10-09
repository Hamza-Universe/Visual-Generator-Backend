import type { RenderStyle } from './types.js';

/**
 * Canonical per-instance style (Stage 2D, Phase 7).
 *
 * Order — position → size → scale → rotation → opacity — matches the
 * editor's historic interpretation byte-for-byte, so browser CSS and
 * Remotion inline styles agree:
 *   left/top from position, width/height from size,
 *   transform `rotate(Rdeg) scale(SX, SY)`, opacity, zIndex.
 */
export const renderStyleFor = (instance: {
  position: { x: number; y: number };
  size: { width: number; height: number };
  transform: { rotation?: number; scaleX?: number; scaleY?: number };
  style: { opacity?: number };
  zIndex: number;
}): RenderStyle => {
  const rotation = instance.transform.rotation ?? 0;
  const scaleX = instance.transform.scaleX ?? 1;
  const scaleY = instance.transform.scaleY ?? 1;
  return {
    left: instance.position.x,
    top: instance.position.y,
    width: instance.size.width,
    height: instance.size.height,
    opacity: instance.style.opacity ?? 1,
    transform: `rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`,
    zIndex: instance.zIndex,
  };
};

export const isStyleEqual = (a: RenderStyle, b: RenderStyle): boolean =>
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.height === b.height &&
  a.opacity === b.opacity &&
  a.transform === b.transform &&
  a.zIndex === b.zIndex;
