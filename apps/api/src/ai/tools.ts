import { z } from 'zod';
import type { SceneDocument } from '@app/schema';

/**
 * Minimal internal tool harness (Stage 4A) + bounded agent tool registry
 * (Stage 4B).
 *
 * Pure read tools plus deterministic layout math over an in-memory
 * SceneDocument snapshot. Read tools inspect; write intent flows through
 * validated operation plans, never through direct mutation here. The
 * registry below is the explicit allowlist the bounded agent may call —
 * every argument is Zod-validated and every result is size-capped before
 * it reaches the model. Tools receive only a snapshot: no database, no
 * filesystem, no network, no state mutation.
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

/** Deterministic bounding-box overlap test (shared with verification). */
export const boxesOverlap = (
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

export interface ToolInstanceDetail extends ToolInstanceSummary {
  visible: boolean;
  zIndex: number;
  groupId: string | null;
}

/** Full detail for one instance (bounded fields only), or null when absent. */
export const getInstance = (
  document: SceneDocument,
  instanceId: string,
): ToolInstanceDetail | null => {
  const instance = document.components.find((c) => c.id === instanceId);
  if (!instance) return null;
  return {
    id: instance.id,
    definitionId: instance.componentDefinitionId,
    label: toolLabelOf((instance.props ?? {}) as Record<string, unknown>),
    position: { ...instance.position },
    size: { ...instance.size },
    visible: instance.visible,
    zIndex: instance.zIndex,
    groupId: instance.groupId ?? null,
  };
};

/**
 * Pairs whose bounding boxes overlap where at least one member is among
 * `instanceIds` — "does this object collide with anything in the scene?".
 * The calculation is deterministic; the model never asserts overlaps.
 */
export const findSceneOverlaps = (
  document: SceneDocument,
  instanceIds: string[],
): Array<[string, string]> => {
  const targets = new Set(instanceIds);
  const pairs: Array<[string, string]> = [];
  const components = document.components;
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const a = components[i];
      const b = components[j];
      if (!targets.has(a.id) && !targets.has(b.id)) continue;
      const boundsA = getInstanceBounds(document, a.id);
      const boundsB = getInstanceBounds(document, b.id);
      if (boundsA && boundsB && boxesOverlap(boundsA, boundsB)) {
        pairs.push([a.id, b.id]);
      }
    }
  }
  return pairs;
};

// ---------------------------------------------------------------------------
// Bounded agent tool registry (Stage 4B)
// ---------------------------------------------------------------------------

export interface AgentToolSpec {
  name: string;
  description: string;
  /** Human/model-readable argument summary shown in the agent context. */
  args: string;
  argsSchema: z.ZodType;
}

/** Result bounding — tool output must never become an unbounded context. */
export const MAX_TOOL_RESULT_ITEMS = 20;
export const MAX_TOOL_OVERLAP_PAIRS = 40;
export const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Explicit allowlist of read tools the agent may call. Unknown names are
 * rejected before any execution. There is deliberately no write tool:
 * every mutation goes through a validated AIScenePlan.
 */
export const AGENT_TOOL_SPECS: AgentToolSpec[] = [
  {
    name: 'getScene',
    description:
      'Scene metadata: name, fps, durationFrames, instance and group counts.',
    args: '{}',
    argsSchema: z.object({}),
  },
  {
    name: 'findInstances',
    description:
      'Search instances by id substring or label text (text/label/title props). Returns up to 20 matches with a truncated flag.',
    args: '{"query": "..."}',
    argsSchema: z.object({ query: z.string().min(1).max(200) }),
  },
  {
    name: 'getInstance',
    description:
      'Full detail for one instance: definition id, label, position, size, visibility, zIndex, group.',
    args: '{"instanceId": "<uuid>"}',
    argsSchema: z.object({ instanceId: z.string().uuid() }),
  },
  {
    name: 'getInstanceBounds',
    description:
      'Bounding box {x,y,width,height} of one instance, or null when it does not exist.',
    args: '{"instanceId": "<uuid>"}',
    argsSchema: z.object({ instanceId: z.string().uuid() }),
  },
  {
    name: 'findOverlaps',
    description:
      'Overlapping bounding-box pairs. Omit instanceIds for the whole scene. With instanceIds: pairs among them (or against the whole scene when againstScene is true).',
    args: '{"instanceIds": ["<uuid>"], "againstScene": false}',
    argsSchema: z.object({
      instanceIds: z.array(z.string().uuid()).min(1).max(40).optional(),
      againstScene: z.boolean().optional(),
    }),
  },
];

export const AGENT_TOOL_NAMES: string[] = AGENT_TOOL_SPECS.map(
  (spec) => spec.name,
);

export type AgentToolOutcome =
  | { ok: true; result: unknown }
  | {
      ok: false;
      code: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'TOOL_FAILED';
      message: string;
    };

const boundToolResult = (result: unknown): unknown => {
  const json = JSON.stringify(result);
  if (json !== undefined && json.length <= MAX_TOOL_RESULT_CHARS) return result;
  return {
    truncated: true,
    note: `Result exceeded ${MAX_TOOL_RESULT_CHARS} characters; narrow the query (search first, then read a single instance).`,
  };
};

const runAgentTool = (
  name: string,
  args: Record<string, unknown>,
  document: SceneDocument,
): unknown => {
  switch (name) {
    case 'getScene':
      return getSceneSummary(document);
    case 'findInstances': {
      const matches = findInstances(document, String(args.query ?? ''));
      const items = matches.slice(0, MAX_TOOL_RESULT_ITEMS);
      return {
        items,
        totalMatches: matches.length,
        truncated: matches.length > items.length,
      };
    }
    case 'getInstance':
      return getInstance(document, String(args.instanceId ?? ''));
    case 'getInstanceBounds':
      return getInstanceBounds(document, String(args.instanceId ?? ''));
    case 'findOverlaps': {
      const instanceIds =
        args.instanceIds === undefined
          ? undefined
          : (args.instanceIds as string[]);
      const pairs = !instanceIds
        ? findOverlaps(document)
        : args.againstScene === true
          ? findSceneOverlaps(document, instanceIds)
          : findOverlaps(document, instanceIds);
      const bounded = pairs.slice(0, MAX_TOOL_OVERLAP_PAIRS);
      return {
        pairs: bounded,
        totalPairs: pairs.length,
        truncated: pairs.length > bounded.length,
      };
    }
    default:
      return null;
  }
};

/**
 * Execute one allowlisted read tool against a document snapshot.
 * Never throws: unknown tools and malformed arguments come back as
 * structured outcomes the harness feeds back to the model.
 */
export const executeAgentTool = (input: {
  name: string;
  args: unknown;
  document: SceneDocument;
}): AgentToolOutcome => {
  const spec = AGENT_TOOL_SPECS.find((candidate) => candidate.name === input.name);
  if (!spec) {
    return {
      ok: false,
      code: 'UNKNOWN_TOOL',
      message: `Unknown tool "${input.name}". Allowed tools: ${AGENT_TOOL_NAMES.join(', ')}`,
    };
  }
  const rawArgs =
    input.args !== null && typeof input.args === 'object' && !Array.isArray(input.args)
      ? input.args
      : {};
  const parsed = spec.argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      code: 'INVALID_ARGUMENTS',
      message: `Invalid arguments for ${spec.name} (${issues})`,
    };
  }
  try {
    const result = runAgentTool(
      spec.name,
      parsed.data as Record<string, unknown>,
      input.document,
    );
    return { ok: true, result: boundToolResult(result) };
  } catch {
    return {
      ok: false,
      code: 'TOOL_FAILED',
      message: `Tool ${spec.name} could not read the scene snapshot`,
    };
  }
};
