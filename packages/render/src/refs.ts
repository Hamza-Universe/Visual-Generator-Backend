import { boundsOf, connectorEndpoints } from './geometry.js';
import type { RenderPoint } from './types.js';

/**
 * Generic reference resolution (Stage 2D, Phase 6). Same semantics as the
 * editor: definition `refProps` name the props, instance ids are the values,
 * empty/missing means unset. No legacy scene-ID behavior anywhere.
 */

/** The referenced instance id for one ref prop, or null when unset. */
export const instanceRefId = (
  instance: { props: Record<string, unknown> },
  prop: string,
): string | null => {
  const value = instance.props[prop];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** Resolve a referenced id against the scene's component list. */
export const resolveReference = <T extends { id: string }>(
  components: T[],
  targetId: string,
): T | undefined => components.find((c) => c.id === targetId);

/**
 * Scene-space connector endpoints for an instance's `from`/`to` reference
 * props. Returns null when either end is missing, unknown, or explicitly
 * hidden — callers render their safe fallback instead of crashing.
 */
export const connectorEndpointsFor = (
  components: Array<{
    id: string;
    props: Record<string, unknown>;
    position: { x: number; y: number };
    size: { width: number; height: number };
    visible: boolean;
  }>,
  instance: { props: Record<string, unknown> },
  fromProp = 'from',
  toProp = 'to',
): { p1: RenderPoint; p2: RenderPoint } | null => {
  const fromId = instanceRefId(instance, fromProp);
  const toId = instanceRefId(instance, toProp);
  const from = fromId ? resolveReference(components, fromId) : undefined;
  const to = toId ? resolveReference(components, toId) : undefined;
  if (!from || !to || from.visible === false || to.visible === false) return null;
  return connectorEndpoints(boundsOf(from), boundsOf(to));
};
