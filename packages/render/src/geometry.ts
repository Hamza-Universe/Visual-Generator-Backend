import type { RenderBounds, RenderPoint, RenderableInstance } from './types.js';

/**
 * Canonical render geometry (Stage 2D). Axis-aligned, world-space boxes.
 * Rotation is a render-time transform only — bounds never rotate.
 */

/** Axis-aligned box of one instance (position + size, unrotated). */
export const boundsOf = (instance: {
  position: { x: number; y: number };
  size: { width: number; height: number };
}): RenderBounds => ({
  x: instance.position.x,
  y: instance.position.y,
  width: Math.max(0, instance.size.width),
  height: Math.max(0, instance.size.height),
});

export const boundsCenter = (bounds: RenderBounds): RenderPoint => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

/** Smallest box containing every box, or null when empty. */
export const unionBounds = (boxes: RenderBounds[]): RenderBounds | null => {
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
};

/** Where the segment inside→outside first exits the rect (fallback: inside). */
export const clipExit = (
  rect: RenderBounds,
  inside: RenderPoint,
  outside: RenderPoint,
): RenderPoint => {
  const dx = outside.x - inside.x;
  const dy = outside.y - inside.y;
  if (dx === 0 && dy === 0) return { ...inside };
  const candidates: number[] = [];
  if (dx !== 0) {
    candidates.push(
      (rect.x - inside.x) / dx,
      (rect.x + rect.width - inside.x) / dx,
    );
  }
  if (dy !== 0) {
    candidates.push(
      (rect.y - inside.y) / dy,
      (rect.y + rect.height - inside.y) / dy,
    );
  }
  const t = Math.min(...candidates.filter((v) => v > 0));
  if (!Number.isFinite(t)) return { ...inside };
  return { x: inside.x + dx * t, y: inside.y + dy * t };
};

/**
 * Connector endpoints between two boxes: each endpoint sits on its own box
 * edge along the center-to-center line. Falls back to centers for degenerate
 * (zero-area / coincident) boxes. Deterministic and side-effect free.
 */
export const connectorEndpoints = (
  from: RenderBounds,
  to: RenderBounds,
): { p1: RenderPoint; p2: RenderPoint } => {
  const c1 = boundsCenter(from);
  const c2 = boundsCenter(to);
  if (c1.x === c2.x && c1.y === c2.y) return { p1: c1, p2: c2 };
  return { p1: clipExit(from, c1, c2), p2: clipExit(to, c2, c1) };
};

export const isRenderableInstance = (value: unknown): value is RenderableInstance => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.position === 'object' &&
    typeof v.size === 'object' &&
    typeof v.visible === 'boolean' &&
    typeof v.zIndex === 'number'
  );
};
