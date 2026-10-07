import type { SceneDocument } from '@app/schema';

/**
 * Minimal internal tool harness (Stage 4A).
 *
 * Pure read tools plus deterministic layout math over an in-memory
 * SceneDocument snapshot. Read tools inspect; write intent flows through
 * validated operation plans, never through direct mutation here. Only the
 * minimum needed for the initial workflow — not an autonomous agent.
 */

export interface ToolInstanceSummary {
  id: string;
  definitionId: string;
  label: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

const toolLabelOf = (props: Record<string, unknown>): string | null => {
  for (const key of ['text', 'label', 'title']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
};

export const getSceneSummary = (document: SceneDocument): Record<string, unknown> => ({
  id: document.id,
  name: document.name,
  timeline: document.timeline,
  instanceCount: document.components.length,
  groupCount: document.groups.length,
});

export const findInstances = (
  document: SceneDocument,
  query: string,
): ToolInstanceSummary[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return document.components
    .filter((instance) => {
      const label = toolLabelOf((instance.props ?? {}) as Record<string, unknown>);
      return (
        instance.id.toLowerCase().includes(needle) ||
        (label ?? '').toLowerCase().includes(needle)
      );
    })
    .map((instance) => ({
      id: instance.id,
      definitionId: instance.componentDefinitionId,
      label: toolLabelOf((instance.props ?? {}) as Record<string, unknown>),
      position: { ...instance.position },
      size: { ...instance.size },
    }));
};

export const getInstanceBounds = (
  document: SceneDocument,
  instanceId: string,
): { x: number; y: number; width: number; height: number } | null => {
  const instance = document.components.find((c) => c.id === instanceId);
  if (!instance) return null;
  return {
    x: instance.position.x,
    y: instance.position.y,
    width: instance.size.width,
    height: instance.size.height,
  };
};

const boxesOverlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Pairs of instance IDs whose bounding boxes overlap. */
export const findOverlaps = (
  document: SceneDocument,
  instanceIds?: string[],
): Array<[string, string]> => {
  const pool = instanceIds
    ? document.components.filter((c) => instanceIds.includes(c.id))
    : document.components;
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = getInstanceBounds(document, pool[i].id);
      const b = getInstanceBounds(document, pool[j].id);
      if (a && b && boxesOverlap(a, b)) pairs.push([pool[i].id, pool[j].id]);
    }
  }
  return pairs;
};

export type AlignAxis = 'x' | 'y';
export type AlignMode = 'min' | 'center' | 'max';

/**
 * Deterministic alignment: AI decides WHAT to align, this decides HOW.
 * Returns computed positions (applied via moveInstance operations).
 */
export const alignInstances = (
  document: SceneDocument,
  instanceIds: string[],
  axis: AlignAxis,
  mode: AlignMode,
): Array<{ instanceId: string; position: { x: number; y: number } }> => {
  const targets = document.components.filter((c) => instanceIds.includes(c.id));
  if (targets.length === 0) return [];
  const edge = (c: (typeof targets)[number]): number =>
    axis === 'x'
      ? mode === 'min'
        ? c.position.x
        : mode === 'max'
          ? c.position.x + c.size.width
          : c.position.x + c.size.width / 2
      : mode === 'min'
        ? c.position.y
        : mode === 'max'
          ? c.position.y + c.size.height
          : c.position.y + c.size.height / 2;
  const anchor = mode === 'min' ? Math.min(...targets.map(edge)) : mode === 'max' ? Math.max(...targets.map(edge)) : edge(targets[0]);
  return targets.map((c) => ({
    instanceId: c.id,
    position:
      axis === 'x'
        ? {
            x: mode === 'min' ? anchor : mode === 'max' ? anchor - c.size.width : anchor - c.size.width / 2,
            y: c.position.y,
          }
        : {
            x: c.position.x,
            y: mode === 'min' ? anchor : mode === 'max' ? anchor - c.size.height : anchor - c.size.height / 2,
          },
  }));
};

/**
 * Deterministic distribution along one axis: first and last instances keep
 * their positions; the rest spread evenly between them.
 */
export const distributeInstances = (
  document: SceneDocument,
  instanceIds: string[],
  axis: AlignAxis,
): Array<{ instanceId: string; position: { x: number; y: number } }> => {
  const targets = document.components.filter((c) => instanceIds.includes(c.id));
  if (targets.length < 3) return [];
  const sorted = [...targets].sort((a, b) =>
    axis === 'x' ? a.position.x - b.position.x : a.position.y - b.position.y,
  );
  const first = axis === 'x' ? sorted[0].position.x : sorted[0].position.y;
  const last =
    axis === 'x'
      ? sorted[sorted.length - 1].position.x
      : sorted[sorted.length - 1].position.y;
  const step = (last - first) / (sorted.length - 1);
  return sorted.map((c, index) => ({
    instanceId: c.id,
    position:
      axis === 'x'
        ? { x: first + step * index, y: c.position.y }
        : { x: c.position.x, y: first + step * index },
  }));
};
