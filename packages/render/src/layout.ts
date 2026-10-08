import { boundsOf, connectorEndpoints, unionBounds } from './geometry.js';
import type { RenderBounds } from './types.js';
import { WORLD } from './types.js';

/**
 * Deterministic layout & visual composition engine (Stage 4C).
 *
 *   SceneDocument-like { components, groups } + LayoutIntent + target ids
 *     → resolveLayout(request) → LayoutResult { changes, order, overlaps, warnings }
 *
 * The engine resolves *semantic* layout intent (horizontal, vertical, grid,
 * center, stack/overlay, align, distribute, relationship flow, fit-to-text,
 * canvas constraints, collision handling) into actual component geometry.
 * It is a pure resolution step: the stored document is never modified, and
 * the same request always produces byte-identical output.
 *
 * Layered-composition rule (Stage 4C): scenes are layered compositions, not
 * packing problems. Overlapping bounding boxes are legal and intentional
 * for backgrounds, overlays, highlights, decorations, connectors, and
 * full-screen objects. Nothing is ever separated merely because two boxes
 * intersect:
 *   - collision resolution only runs when explicitly requested
 *     (`intent: { type: 'resolveCollisions' }` or `request.resolveCollisions`);
 *   - pairs where either instance carries `style.layoutOverlap = 'intentional'`
 *     are ALWAYS exempt from resolution;
 *   - deliberate overlays (stack / center-each) and connector↔endpoint pairs
 *     are reported as intentional overlaps, never as collisions.
 *
 * Determinism: no randomness, no clocks, no environment APIs, stable sorts
 * with document-order tie-breaks, all emitted geometry rounded to 2 decimals,
 * bounded passes for collision resolution. Runs identically in browsers,
 * the API, and workers (pure data in, plain data out).
 */

// ---------------------------------------------------------------------------
// Public types (structural — @app/schema documents satisfy them directly)
// ---------------------------------------------------------------------------

export interface LayoutCanvas {
  width: number;
  height: number;
}

export type LayoutAxis = 'x' | 'y';
export type LayoutEdge = 'min' | 'center' | 'max';
export type LayoutJustify = 'start' | 'center' | 'end';
export type LayoutCrossAlign = 'start' | 'center' | 'end';
export type LayoutFlowDirection = 'horizontal' | 'vertical';
export type LayoutCenterMode = 'block' | 'each';
export type LayoutOverlapScope = 'targets' | 'scene';

/**
 * Container a layout resolves against. `canvas` is the scene canvas;
 * `instance`/`group` resolve to that object's current bounds (groups resolve
 * to the union of their members, including nested subgroups). Missing or
 * empty containers fall back to the algorithm's default with a warning —
 * the engine never throws.
 */
export interface LayoutContainerRef {
  kind: 'canvas' | 'instance' | 'group';
  instanceId?: string;
  groupId?: string;
}

export interface LayoutFitTextOptions {
  fontSize?: number;
  maxWidth?: number;
  minWidth?: number;
  paddingX?: number;
  paddingY?: number;
}

/**
 * Semantic layout intent. Each variant resolves to concrete geometry:
 *
 *  - `horizontal` / `vertical` — pack targets into a row/column with a gap,
 *    justified (start/center/end) and cross-aligned inside the container.
 *  - `grid` — row-major uniform cells (cell size = max target size).
 *  - `center` — center the target block, or every target individually
 *    (`mode: 'each'`, a deliberate overlay), inside the container.
 *  - `stack` — overlay every target on one point (intentional overlap),
 *    optionally equalizing sizes to the largest target.
 *  - `align` — align one edge/center of every target to the container edge
 *    (default container = the targets' own union box, i.e. self-align).
 *  - `distribute` — even edge spacing along an axis; first and last keep
 *    their positions.
 *  - `flow` — relationship-based ordering from reference props (from→to
 *    edges, deterministic topological sort) packed along one direction.
 *  - `fitText` — text-aware sizing: resize targets to their text content.
 *  - `constrain` — clamp target positions fully inside the canvas.
 *  - `detectOverlaps` — report overlapping pairs (with intentionality).
 *  - `resolveCollisions` — deterministic collision resolution pass.
 */
export type LayoutIntent =
  | {
      type: 'horizontal';
      gap?: number;
      justify?: LayoutJustify;
      align?: LayoutCrossAlign;
      container?: LayoutContainerRef;
    }
  | {
      type: 'vertical';
      gap?: number;
      justify?: LayoutJustify;
      align?: LayoutCrossAlign;
      container?: LayoutContainerRef;
    }
  | {
      type: 'grid';
      columns?: number;
      gapX?: number;
      gapY?: number;
      container?: LayoutContainerRef;
    }
  | { type: 'center'; mode?: LayoutCenterMode; container?: LayoutContainerRef }
  | { type: 'stack'; equalizeSize?: boolean; container?: LayoutContainerRef }
  | { type: 'align'; axis: LayoutAxis; mode: LayoutEdge; container?: LayoutContainerRef }
  | { type: 'distribute'; axis: LayoutAxis }
  | {
      type: 'flow';
      direction?: LayoutFlowDirection;
      gap?: number;
      align?: LayoutCrossAlign;
      container?: LayoutContainerRef;
    }
  | { type: 'fitText' } & LayoutFitTextOptions
  | { type: 'constrain' }
  | { type: 'detectOverlaps'; scope?: LayoutOverlapScope }
  | { type: 'resolveCollisions'; maxPasses?: number };

export interface LayoutInstance {
  id: string;
  props: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
  visible: boolean;
  zIndex: number;
  groupId?: string | null;
  style?: { opacity?: number; [key: string]: unknown } | null;
}

export interface LayoutGroup {
  id: string;
  parentGroupId?: string | null;
  zIndex?: number;
}

export interface LayoutDocument {
  components: LayoutInstance[];
  groups: LayoutGroup[];
}

export interface LayoutRequest {
  document: LayoutDocument;
  /** Already-resolved instance ids (refs/clientKeys are resolved by callers). */
  targets: string[];
  intent: LayoutIntent;
  /** Canvas box; defaults to the canonical WORLD size (1600×900). */
  canvas?: LayoutCanvas;
  /** Clamp final positions fully inside the canvas. */
  constrainToCanvas?: boolean;
  /** Run a deterministic collision-resolution pass after the main algorithm. */
  resolveCollisions?: boolean;
  /**
   * Reference prop pair identifying relationship components, e.g.
   * `['from', 'to']`. Enables flow ordering, connector re-anchoring, and
   * connector-aware overlap semantics. Omitted: instances are plain boxes.
   */
  refProps?: [string, string];
  /** Report overlapping pairs in the result (always on for detectOverlaps). */
  reportOverlaps?: boolean;
}

export interface LayoutChange {
  id: string;
  position: { x: number; y: number };
  /** Present only when the layout changed the instance's size. */
  size?: { width: number; height: number };
}

export interface LayoutOverlapPair {
  a: string;
  b: string;
  /** True when the overlap is semantically allowed (layered composition). */
  intentional: boolean;
}

export interface LayoutResult {
  /** Minimal geometry deltas in document order; unchanged geometry omitted. */
  changes: LayoutChange[];
  /** Targets in the order the algorithm arranged them. */
  order: string[];
  /** Overlapping pairs (empty unless detectOverlaps / reportOverlaps). */
  overlaps: LayoutOverlapPair[];
  /** Bounded, human-readable notes (`missing-target:<id>`, `flow-cycle`, …). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LAYOUT_DEFAULT_GAP = 16;
/** Flow needs visible room for connectors between related objects. */
export const LAYOUT_DEFAULT_FLOW_GAP = 60;
export const LAYOUT_DEFAULT_FONT_SIZE = 16;
export const LAYOUT_MAX_OVERLAP_PAIRS = 200;
export const LAYOUT_MAX_WARNINGS = 20;
/** Separation nudges use 0.01 so 2-decimal rounding can never re-overlap. */
export const LAYOUT_COLLISION_EPSILON = 0.01;
/** Default bound for collision-resolution passes (deterministic termination). */
export const LAYOUT_DEFAULT_MAX_PASSES = 32;

/** Style key marking an instance as an intentional (layered) overlap. */
export const INTENTIONAL_OVERLAP_STYLE_KEY = 'layoutOverlap';
export const INTENTIONAL_OVERLAP_VALUE = 'intentional';

/** Props inspected for text content, in priority order (mirrors the tools). */
export const TEXT_PROPS = ['text', 'label', 'title'] as const;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Round to 2 decimals (stable emitted geometry; -0 normalized to 0). */
const round2 = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Strict bounding-box intersection; edge-touching boxes do NOT overlap. */
export const boxesIntersect = (a: RenderBounds, b: RenderBounds): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** True when an instance is explicitly marked as an intentional overlap. */
export const isIntentionalOverlap = (instance: {
  style?: { opacity?: number; [key: string]: unknown } | null;
}): boolean =>
  instance?.style?.[INTENTIONAL_OVERLAP_STYLE_KEY] === INTENTIONAL_OVERLAP_VALUE;

/** The text content of an instance, or null when it carries no text prop. */
export const instanceText = (instance: LayoutInstance): string | null => {
  const props = instance.props ?? {};
  for (const key of TEXT_PROPS) {
    const value = props[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
};

const fontSizeOf = (instance: LayoutInstance, fallback?: number): number => {
  const fromProps = num((instance.props ?? {}).fontSize, 0);
  return fromProps > 0 ? fromProps : num(fallback, LAYOUT_DEFAULT_FONT_SIZE);
};

// ---------------------------------------------------------------------------
// Text-aware measurement (deterministic approximation, no DOM)
// ---------------------------------------------------------------------------

export interface TextMeasureOptions {
  fontSize?: number;
  /** Maximum total width (including padding); text wraps greedily to fit. */
  maxWidth?: number;
  minWidth?: number;
  paddingX?: number;
  paddingY?: number;
  /** Average glyph width as a fraction of fontSize (default 0.6). */
  charWidthRatio?: number;
  /** Line height as a fraction of fontSize (default 1.25). */
  lineHeightRatio?: number;
}

export interface TextSize {
  width: number;
  height: number;
}

/**
 * Deterministic text measurement used by `fitText`. Approximates sans-serif
 * metrics (avg glyph = 0.6em, line height = 1.25em) so every renderer agrees
 * byte-for-byte — no DOM, no font loading, no hidden state. Supports explicit
 * newlines and greedy word wrapping to `maxWidth`.
 */
export const measureTextSize = (
  text: string,
  options: TextMeasureOptions = {},
): TextSize => {
  const fontSize = Math.max(1, num(options.fontSize, LAYOUT_DEFAULT_FONT_SIZE));
  const charWidth = fontSize * clamp(num(options.charWidthRatio, 0.6), 0.1, 4);
  const lineHeight = fontSize * clamp(num(options.lineHeightRatio, 1.25), 0.1, 8);
  const paddingX = Math.max(0, num(options.paddingX, 0));
  const paddingY = Math.max(0, num(options.paddingY, 0));
  const maxWidth = num(options.maxWidth, 0) > 0 ? num(options.maxWidth, 0) : 0;
  const innerMax =
    maxWidth > 0 ? Math.max(charWidth, maxWidth - paddingX * 2) : 0;

  const rawLines = String(text ?? '').split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if (innerMax <= 0 || line.length * charWidth <= innerMax) {
      lines.push(line);
      continue;
    }
    // Greedy word wrap; words wider than the limit hard-split deterministically.
    let current = '';
    const flush = (): void => {
      if (current !== '') lines.push(current);
      current = '';
    };
    for (const word of line.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (candidate.length * charWidth <= innerMax) {
        current = candidate;
        continue;
      }
      flush();
      if (word.length * charWidth <= innerMax) {
        current = word;
        continue;
      }
      let chunk = '';
      for (const char of word) {
        if ((chunk + char).length * charWidth > innerMax && chunk !== '') {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    }
    flush();
  }

  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  let width = longest * charWidth + paddingX * 2;
  if (maxWidth > 0) width = Math.min(width, maxWidth);
  const minWidth = num(options.minWidth, 0);
  if (minWidth > 0) width = Math.max(width, minWidth);
  return {
    width: round2(Math.max(1, width)),
    height: round2(Math.max(1, lines.length * lineHeight + paddingY * 2)),
  };
};

// ---------------------------------------------------------------------------
// Relationship / connector helpers
// ---------------------------------------------------------------------------

interface RefPair {
  from: string;
  to: string;
}

/** Both reference props set to non-empty strings → this is a connector. */
const refPairOf = (
  instance: LayoutInstance | undefined,
  refProps: [string, string] | null,
): RefPair | null => {
  if (!instance || !refProps) return null;
  const from = instance.props?.[refProps[0]];
  const to = instance.props?.[refProps[1]];
  if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
    return null;
  }
  return { from, to };
};

/**
 * Bounding box of the connector segment between two boxes: the box spanned
 * by the two edge-clipped endpoints (minimum 1×1 for degenerate segments).
 * Edge-touching endpoints never count as overlaps (strict intersection).
 */
const connectorBox = (from: RenderBounds, to: RenderBounds): RenderBounds => {
  const { p1, p2 } = connectorEndpoints(from, to);
  return {
    x: round2(Math.min(p1.x, p2.x)),
    y: round2(Math.min(p1.y, p2.y)),
    width: round2(Math.max(Math.abs(p2.x - p1.x), 1)),
    height: round2(Math.max(Math.abs(p2.y - p1.y), 1)),
  };
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface WorkingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const toWorking = (bounds: RenderBounds): WorkingBox => ({
  x: bounds.x,
  y: bounds.y,
  w: bounds.width,
  h: bounds.height,
});

const toBounds = (box: WorkingBox): RenderBounds => ({
  x: box.x,
  y: box.y,
  width: box.w,
  height: box.h,
});

/** Descendant group ids of `groupId` (inclusive), cycle-safe. */
const descendantGroupIds = (document: LayoutDocument, groupId: string): Set<string> => {
  const children = new Map<string, string[]>();
  for (const group of document.groups) {
    const parent = group.parentGroupId ?? null;
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(group.id);
    children.set(parent, list);
  }
  const out = new Set<string>([groupId]);
  const queue = [groupId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of children.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
};

const normalizeCanvas = (canvas: LayoutCanvas | undefined): LayoutCanvas => {
  const width = num(canvas?.width, 0);
  const height = num(canvas?.height, 0);
  if (width > 0 && height > 0) return { width, height };
  return { width: WORLD.width, height: WORLD.height };
};

/**
 * Resolve semantic layout intent into geometry deltas. Pure and total:
 * never mutates the document, never throws, always returns deterministically
 * ordered output.
 */
export const resolveLayout = (request: LayoutRequest): LayoutResult => {
  const document = request.document;
  const intent = request.intent;
  const canvas = normalizeCanvas(request.canvas);
  const refProps = request.refProps ?? null;

  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (warnings.length < LAYOUT_MAX_WARNINGS) warnings.push(message);
    else if (warnings[warnings.length - 1] !== 'warnings-truncated') {
      warnings.push('warnings-truncated');
    }
  };

  const byId = new Map(document.components.map((component) => [component.id, component]));
  const docIndex = new Map(document.components.map((component, index) => [component.id, index]));
  const indexOf = (id: string): number => docIndex.get(id) ?? Number.MAX_SAFE_INTEGER;

  // --- target resolution: dedupe, drop unknown ids, normalize to doc order ---
  const seen = new Set<string>();
  const targetIds: string[] = [];
  for (const id of request.targets) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!byId.has(id)) {
      warn(`missing-target:${id}`);
      continue;
    }
    targetIds.push(id);
  }
  targetIds.sort((a, b) => indexOf(a) - indexOf(b));
  const targetSet = new Set(targetIds);

  // Connectors (instances carrying the full reference pair) are derived
  // geometry: excluded from direct arrangement, re-anchored to their final
  // endpoints after every other pass. Without refProps everything is a box.
  const refPair = (instance: LayoutInstance | undefined): RefPair | null =>
    refPairOf(instance, refProps);
  const arrangedIds = targetIds.filter((id) => !refPair(byId.get(id)));
  const connectorInstances = refProps
    ? document.components.filter((component) => refPair(component) !== null)
    : [];

  // --- working geometry (only touched ids; reads fall back to the document) ---
  const working = new Map<string, WorkingBox>();
  const readBox = (id: string): WorkingBox => {
    const cached = working.get(id);
    if (cached) return cached;
    const instance = byId.get(id);
    if (!instance) return { x: 0, y: 0, w: 0, h: 0 };
    return toWorking(boundsOf(instance));
  };
  const writeBox = (id: string, box: WorkingBox): void => {
    working.set(id, { x: round2(box.x), y: round2(box.y), w: round2(box.w), h: round2(box.h) });
  };

  /** Pairs deliberately overlaid by this operation (stack / center-each). */
  const deliberateOverlay = new Set<string>();

  // --- container resolution -------------------------------------------------
  const arrangedBounds = (): RenderBounds => {
    const boxes = arrangedIds.map((id) => boundsOf(byId.get(id) as LayoutInstance));
    return unionBounds(boxes) ?? { x: 0, y: 0, width: canvas.width, height: canvas.height };
  };
  const resolveContainer = (
    container: LayoutContainerRef | undefined,
    fallback: RenderBounds,
  ): RenderBounds => {
    if (!container) return fallback;
    if (container.kind === 'canvas') {
      return { x: 0, y: 0, width: canvas.width, height: canvas.height };
    }
    if (container.kind === 'instance') {
      const instance = container.instanceId ? byId.get(container.instanceId) : undefined;
      if (!instance) {
        warn('container-not-found');
        return fallback;
      }
      return boundsOf(instance);
    }
    const groupId = container.groupId;
    if (!groupId) {
      warn('container-not-found');
      return fallback;
    }
    const members = descendantGroupIds(document, groupId);
    const boxes = document.components
      .filter((component) => component.groupId && members.has(component.groupId))
      .map((component) => boundsOf(component));
    const union = unionBounds(boxes);
    if (!union) {
      warn('container-empty');
      return fallback;
    }
    return union;
  };

  const clampToCanvas = (box: WorkingBox): WorkingBox => ({
    ...box,
    x: clamp(box.x, 0, Math.max(0, canvas.width - box.w)),
    y: clamp(box.y, 0, Math.max(0, canvas.height - box.h)),
  });

  let order: string[] = [...targetIds];

  // --- packing primitives ---------------------------------------------------
  const packAxis = (
    ids: string[],
    opts: {
      axis: LayoutAxis;
      gap: number;
      justify: LayoutJustify;
      align: LayoutCrossAlign;
      bounds: RenderBounds;
    },
  ): void => {
    const { axis, gap, justify, align, bounds } = opts;
    const boxes = ids.map((id) => ({ id, ...readBox(id) }));
    if (boxes.length === 0) return;
    const mainSize = (b: WorkingBox): number => (axis === 'x' ? b.w : b.h);
    const crossSize = (b: WorkingBox): number => (axis === 'x' ? b.h : b.w);
    const total =
      boxes.reduce((sum, b) => sum + mainSize(b), 0) + gap * (boxes.length - 1);
    const extent = axis === 'x' ? bounds.width : bounds.height;
    const origin = axis === 'x' ? bounds.x : bounds.y;
    let cursor =
      justify === 'start'
        ? origin
        : justify === 'center'
          ? origin + (extent - total) / 2
          : origin + extent - total;
    for (const box of boxes) {
      const crossOrigin =
        align === 'start'
          ? (axis === 'x' ? bounds.y : bounds.x)
          : align === 'center'
            ? (axis === 'x' ? bounds.y : bounds.x) +
              ((axis === 'x' ? bounds.height : bounds.width) - crossSize(box)) / 2
            : (axis === 'x' ? bounds.y : bounds.x) +
              (axis === 'x' ? bounds.height : bounds.width) -
              crossSize(box);
      writeBox(
        box.id,
        axis === 'x'
          ? { x: cursor, y: crossOrigin, w: box.w, h: box.h }
          : { x: crossOrigin, y: cursor, w: box.w, h: box.h },
      );
      cursor += mainSize(box) + gap;
    }
  };

  const alignEdge = (
    bounds: RenderBounds,
    axis: LayoutAxis,
    mode: LayoutEdge,
    size: number,
  ): number =>
    mode === 'min'
      ? (axis === 'x' ? bounds.x : bounds.y)
      : mode === 'max'
        ? (axis === 'x' ? bounds.x + bounds.width : bounds.y + bounds.height) - size
        : (axis === 'x' ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2) -
          size / 2;

  // --- deterministic topological order for relationship flow ---------------
  const flowOrder = (): string[] => {
    if (!refProps) {
      warn('flow-no-refs');
      return [...arrangedIds];
    }
    const nodeSet = new Set(arrangedIds);
    const indegree = new Map<string, number>(arrangedIds.map((id) => [id, 0]));
    const outgoing = new Map<string, string[]>();
    // Edges come from connector instances (from→to) linking arranged nodes —
    // connectors themselves are excluded from arrangement above.
    for (const connector of connectorInstances) {
      const refs = refPair(connector);
      if (!refs || !nodeSet.has(refs.from) || !nodeSet.has(refs.to)) continue;
      // from → to: a dependency flows before its dependent.
      const list = outgoing.get(refs.from) ?? [];
      list.push(refs.to);
      outgoing.set(refs.from, list);
      indegree.set(refs.to, (indegree.get(refs.to) ?? 0) + 1);
    }
    const ready = arrangedIds.filter((id) => (indegree.get(id) ?? 0) === 0);
    ready.sort((a, b) => indexOf(a) - indexOf(b));
    const result: string[] = [];
    const emitted = new Set<string>();
    while (ready.length > 0) {
      const id = ready.shift() as string;
      if (emitted.has(id)) continue;
      emitted.add(id);
      result.push(id);
      const next: string[] = [];
      for (const dependent of outgoing.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
      next.sort((a, b) => indexOf(a) - indexOf(b));
      ready.push(...next);
    }
    if (result.length < arrangedIds.length) {
      // Cycle (or unreachable nodes): append the remainder in document order.
      warn('flow-cycle');
      for (const id of arrangedIds) {
        if (!emitted.has(id)) result.push(id);
      }
    }
    return result;
  };

  // --- main algorithm -------------------------------------------------------
  const runMain = (): void => {
    switch (intent.type) {
      case 'horizontal': {
        packAxis(arrangedIds, {
          axis: 'x',
          gap: Math.max(0, num(intent.gap, LAYOUT_DEFAULT_GAP)),
          justify: intent.justify ?? 'start',
          align: intent.align ?? 'start',
          bounds: resolveContainer(intent.container, arrangedBounds()),
        });
        return;
      }
      case 'vertical': {
        packAxis(arrangedIds, {
          axis: 'y',
          gap: Math.max(0, num(intent.gap, LAYOUT_DEFAULT_GAP)),
          justify: intent.justify ?? 'start',
          align: intent.align ?? 'start',
          bounds: resolveContainer(intent.container, arrangedBounds()),
        });
        return;
      }
      case 'grid': {
        const bounds = resolveContainer(intent.container, arrangedBounds());
        const count = arrangedIds.length;
        if (count === 0) return;
        const columns = clamp(
          Math.max(1, Math.floor(num(intent.columns, Math.ceil(Math.sqrt(count))))),
          1,
          count,
        );
        const gapX = Math.max(0, num(intent.gapX, LAYOUT_DEFAULT_GAP));
        const gapY = Math.max(0, num(intent.gapY, LAYOUT_DEFAULT_GAP));
        const boxes = arrangedIds.map((id) => ({ id, ...readBox(id) }));
        const cellWidth = boxes.reduce((max, b) => Math.max(max, b.w), 0);
        const cellHeight = boxes.reduce((max, b) => Math.max(max, b.h), 0);
        boxes.forEach((box, index) => {
          const column = index % columns;
          const row = Math.floor(index / columns);
          writeBox(box.id, {
            x: bounds.x + column * (cellWidth + gapX),
            y: bounds.y + row * (cellHeight + gapY),
            w: box.w,
            h: box.h,
          });
        });
        return;
      }
      case 'center': {
        const mode = intent.mode ?? 'block';
        const bounds = resolveContainer(intent.container, {
          x: 0,
          y: 0,
          width: canvas.width,
          height: canvas.height,
        });
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        if (mode === 'each') {
          for (const id of arrangedIds) {
            const box = readBox(id);
            deliberateOverlay.add(id);
            writeBox(id, {
              x: centerX - box.w / 2,
              y: centerY - box.h / 2,
              w: box.w,
              h: box.h,
            });
          }
          return;
        }
        const union = unionBounds(arrangedIds.map((id) => boundsOf(byId.get(id) as LayoutInstance)));
        if (!union) return;
        const dx = centerX - (union.x + union.width / 2);
        const dy = centerY - (union.y + union.height / 2);
        for (const id of arrangedIds) {
          const box = readBox(id);
          writeBox(id, { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h });
        }
        return;
      }
      case 'stack': {
        const bounds = resolveContainer(intent.container, arrangedBounds());
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        let maxWidth = 0;
        let maxHeight = 0;
        for (const id of arrangedIds) {
          const box = readBox(id);
          maxWidth = Math.max(maxWidth, box.w);
          maxHeight = Math.max(maxHeight, box.h);
        }
        for (const id of arrangedIds) {
          const box = readBox(id);
          const width = intent.equalizeSize ? maxWidth : box.w;
          const height = intent.equalizeSize ? maxHeight : box.h;
          deliberateOverlay.add(id);
          writeBox(id, {
            x: centerX - width / 2,
            y: centerY - height / 2,
            w: width,
            h: height,
          });
        }
        return;
      }
      case 'align': {
        const bounds = resolveContainer(intent.container, arrangedBounds());
        for (const id of arrangedIds) {
          const box = readBox(id);
          const x = alignEdge(bounds, intent.axis, intent.mode, box.w);
          const y = alignEdge(bounds, intent.axis, intent.mode, box.h);
          writeBox(id, {
            x: intent.axis === 'x' ? x : box.x,
            y: intent.axis === 'y' ? y : box.y,
            w: box.w,
            h: box.h,
          });
        }
        return;
      }
      case 'distribute': {
        const axis = intent.axis;
        const sorted = [...arrangedIds].sort((a, b) => {
          const boxA = readBox(a);
          const boxB = readBox(b);
          const mainA = axis === 'x' ? boxA.x : boxA.y;
          const mainB = axis === 'x' ? boxB.x : boxB.y;
          return mainA - mainB || indexOf(a) - indexOf(b);
        });
        order = sorted;
        if (sorted.length < 2) return;
        const first = readBox(sorted[0]);
        const last = readBox(sorted[sorted.length - 1]);
        const leading = axis === 'x' ? first.x : first.y;
        const trailing = axis === 'x' ? last.x + last.w : last.y + last.h;
        // Even edge gaps: leading + Σ sizes + (n−1)·gap + w_last = trailing
        // ⇒ gap = (trailing − leading − Σ all sizes) / (n − 1).
        const totalSize = sorted.reduce(
          (sum, id) => sum + (axis === 'x' ? readBox(id).w : readBox(id).h),
          0,
        );
        const gap = (trailing - leading - totalSize) / (sorted.length - 1);
        let cursor = leading;
        sorted.forEach((id, index) => {
          const box = readBox(id);
          if (index === 0) {
            cursor += (axis === 'x' ? box.w : box.h) + gap;
            return;
          }
          if (index === sorted.length - 1) return; // last keeps its position
          writeBox(
            id,
            axis === 'x'
              ? { x: cursor, y: box.y, w: box.w, h: box.h }
              : { x: box.x, y: cursor, w: box.w, h: box.h },
          );
          cursor += (axis === 'x' ? box.w : box.h) + gap;
        });
        return;
      }
      case 'flow': {
        const ids = flowOrder();
        order = ids;
        const direction = intent.direction ?? 'horizontal';
        packAxis(ids, {
          axis: direction === 'horizontal' ? 'x' : 'y',
          gap: Math.max(0, num(intent.gap, LAYOUT_DEFAULT_FLOW_GAP)),
          justify: 'start',
          align: intent.align ?? 'start',
          bounds: resolveContainer(intent.container, arrangedBounds()),
        });
        return;
      }
      case 'fitText': {
        for (const id of arrangedIds) {
          const instance = byId.get(id) as LayoutInstance;
          const text = instanceText(instance);
          if (text === null) continue; // non-text instances keep their size
          const size = measureTextSize(text, {
            fontSize: fontSizeOf(instance, intent.fontSize),
            ...(intent.maxWidth !== undefined ? { maxWidth: intent.maxWidth } : {}),
            ...(intent.minWidth !== undefined ? { minWidth: intent.minWidth } : {}),
            paddingX: Math.max(0, num(intent.paddingX, 0)),
            paddingY: Math.max(0, num(intent.paddingY, 0)),
          });
          const box = readBox(id);
          writeBox(id, { x: box.x, y: box.y, w: size.width, h: size.height });
        }
        return;
      }
      case 'constrain':
      case 'detectOverlaps':
      case 'resolveCollisions':
        // Handled by the dedicated passes below.
        return;
      default: {
        const exhaustive: never = intent;
        void exhaustive;
      }
    }
  };

  runMain();

  // --- deterministic collision resolution (opt-in) --------------------------
  const wantsResolution =
    request.resolveCollisions === true || intent.type === 'resolveCollisions';
  const resolveCollisionsPass = (): void => {
    if (arrangedIds.length < 2) return;
    const maxPasses = clamp(
      Math.floor(
        intent.type === 'resolveCollisions'
          ? num(intent.maxPasses, LAYOUT_DEFAULT_MAX_PASSES)
          : LAYOUT_DEFAULT_MAX_PASSES,
      ),
      1,
      100,
    );
    // Stable order: lower zIndex / earlier document order stays put.
    const pool = [...arrangedIds].sort((a, b) => {
      const zA = byId.get(a)?.zIndex ?? 0;
      const zB = byId.get(b)?.zIndex ?? 0;
      return zA - zB || indexOf(a) - indexOf(b);
    });
    const exempt = (id: string): boolean => isIntentionalOverlap(byId.get(id) as LayoutInstance);
    // One deterministic move per pass; stop as soon as a pass finds nothing.
    let clean = false;
    for (let pass = 0; pass < maxPasses; pass++) {
      let moved = false;
      outer: for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const a = readBox(pool[i]);
          const b = readBox(pool[j]);
          if (exempt(pool[i]) || exempt(pool[j])) continue;
          if (!boxesIntersect(toBounds(a), toBounds(b))) continue;
          moved = true;
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          // Minimum-overlap axis; ties resolve to x.
          const axis: LayoutAxis = overlapX <= overlapY ? 'x' : 'y';
          const centerA = axis === 'x' ? a.x + a.w / 2 : a.y + a.h / 2;
          const centerB = axis === 'x' ? b.x + b.w / 2 : b.y + b.h / 2;
          const direction = centerB >= centerA ? 1 : -1;
          let next: WorkingBox;
          if (axis === 'x') {
            const x =
              direction > 0
                ? round2(a.x + a.w) + LAYOUT_COLLISION_EPSILON
                : round2(a.x) - LAYOUT_COLLISION_EPSILON - b.w;
            next = { ...b, x };
          } else {
            const y =
              direction > 0
                ? round2(a.y + a.h) + LAYOUT_COLLISION_EPSILON
                : round2(a.y) - LAYOUT_COLLISION_EPSILON - b.h;
            next = { ...b, y };
          }
          if (next.x === b.x && next.y === b.y) {
            // Guard against rounding stalls: nudge deterministically.
            if (axis === 'x') next.x = round2(b.x + direction * LAYOUT_COLLISION_EPSILON);
            else next.y = round2(b.y + direction * LAYOUT_COLLISION_EPSILON);
          }
          const movedBox = request.constrainToCanvas === true ? clampToCanvas(next) : next;
          writeBox(pool[j], movedBox);
          break outer;
        }
      }
      if (!moved) {
        clean = true;
        break;
      }
    }
    if (!clean) warn('collision-resolution-exceeded');
  };
  if (wantsResolution) resolveCollisionsPass();

  // --- canvas constraint pass (opt-in or standalone intent) -----------------
  if (request.constrainToCanvas === true || intent.type === 'constrain') {
    for (const id of arrangedIds) {
      writeBox(id, clampToCanvas(readBox(id)));
    }
  }

  // --- connector re-anchoring (after endpoints are final) -------------------
  // Read-only intents (detectOverlaps) never rewrite geometry.
  if (refProps && intent.type !== 'detectOverlaps') {
    for (const connector of connectorInstances) {
      const refs = refPair(connector);
      if (!refs) continue;
      const from = byId.get(refs.from);
      const to = byId.get(refs.to);
      // Dangling references keep their box: the renderer already falls back.
      if (!from || !to) continue;
      writeBox(
        connector.id,
        toWorking(
          connectorBox(toBounds(readBox(from.id)), toBounds(readBox(to.id))),
        ),
      );
    }
  }

  // --- emit minimal changes in document order -------------------------------
  const touched = [...working.keys()].sort((a, b) => indexOf(a) - indexOf(b));
  const changes: LayoutChange[] = [];
  for (const id of touched) {
    const box = working.get(id) as WorkingBox;
    const original = byId.get(id) as LayoutInstance;
    const positionSame =
      round2(box.x) === round2(original.position.x) &&
      round2(box.y) === round2(original.position.y);
    const sizeSame =
      round2(box.w) === round2(original.size.width) &&
      round2(box.h) === round2(original.size.height);
    if (positionSame && sizeSame) continue;
    changes.push({
      id,
      position: { x: round2(box.x), y: round2(box.y) },
      ...(sizeSame
        ? {}
        : { size: { width: round2(box.w), height: round2(box.h) } }),
    });
  }

  // --- overlap report -------------------------------------------------------
  const overlaps: LayoutOverlapPair[] = [];
  if (intent.type === 'detectOverlaps' || request.reportOverlaps === true) {
    const scope: LayoutOverlapScope =
      intent.type === 'detectOverlaps' ? intent.scope ?? 'targets' : 'targets';
    const pool =
      scope === 'scene'
        ? document.components.map((component) => component.id)
        : targetIds;
    const isConnectorOf = (self: string, other: string): boolean => {
      if (!refProps) return false;
      const refs = refPair(byId.get(self));
      return refs !== null && (refs.from === other || refs.to === other);
    };
    outer: for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (overlaps.length >= LAYOUT_MAX_OVERLAP_PAIRS) {
          warn('overlaps-truncated');
          break outer;
        }
        const a = pool[i];
        const b = pool[j];
        const boxA = readBox(a);
        const boxB = readBox(b);
        if (!boxesIntersect(toBounds(boxA), toBounds(boxB))) continue;
        const intentional =
          isIntentionalOverlap(byId.get(a) as LayoutInstance) ||
          isIntentionalOverlap(byId.get(b) as LayoutInstance) ||
          (deliberateOverlay.has(a) && deliberateOverlay.has(b)) ||
          isConnectorOf(a, b) ||
          isConnectorOf(b, a);
        overlaps.push({ a, b, intentional });
      }
    }
  }

  return { changes, order, overlaps, warnings };
};

/** Convenience alias matching the semantic API naming. */
export const applyLayout = resolveLayout;
