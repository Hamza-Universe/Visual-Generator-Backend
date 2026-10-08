/**
 * Shared render contract (Stage 2D).
 *
 * Minimal structural shapes. Both `@app/schema` document types and the
 * frontend `types/api` types satisfy these structurally — this package
 * intentionally depends on neither, so it stays consumable from the
 * Remotion worker, the API, and (via a `file:` dependency) the frontend.
 */

export interface RenderPosition {
  x: number;
  y: number;
}

export interface RenderSize {
  width: number;
  height: number;
}

export interface RenderTransform {
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface RenderInstanceStyle {
  opacity: number;
  [key: string]: unknown;
}

export interface RenderableInstance {
  id: string;
  /** Definition id; resolved to a renderer key via the caller's lookup. */
  componentDefinitionId?: string;
  props: Record<string, unknown>;
  position: RenderPosition;
  size: RenderSize;
  transform: RenderTransform;
  style: RenderInstanceStyle;
  visible: boolean;
  zIndex: number;
  groupId?: string | null;
}

export interface RenderableGroup {
  id: string;
  parentGroupId?: string | null;
  zIndex: number;
}

export interface RenderableDocument {
  components: RenderableInstance[];
  groups: RenderableGroup[];
}

export interface RenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderPoint {
  x: number;
  y: number;
}

/**
 * Canonical per-instance visual style. Plain data (no DOM), so it applies
 * identically to browser CSS and Remotion inline styles.
 *
 * Canonical transform order (matches the editor's historic interpretation):
 *   1. position → left/top
 *   2. size → width/height
 *   3. scale → inside `transform`
 *   4. rotation → inside `transform`, as `rotate(Rdeg) scale(SX, SY)`
 *      (CSS applies the list right-to-left, i.e. scale first in local space)
 *   5. opacity
 *   6. zIndex (stacking; see tree.ts for scope ordering)
 *   7. visibility gates rendering entirely (it is NOT a style)
 */
export interface RenderStyle {
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number;
  transform: string;
  zIndex: number;
}

/** One painted instance: geometry + style + hierarchy context. */
export interface RenderNode<TInstance extends RenderableInstance = RenderableInstance> {
  instance: TInstance;
  /** Enclosing group ids, outermost first. Empty for top-level instances. */
  groupPath: string[];
  depth: number;
  /** 0-based position in deterministic paint order. */
  paintIndex: number;
  bounds: RenderBounds;
  style: RenderStyle;
}

export type RenderTreeNode<TInstance extends RenderableInstance = RenderableInstance> =
  | { type: 'instance'; node: RenderNode<TInstance> }
  | { type: 'group'; group: RenderableGroup; children: RenderTreeNode<TInstance>[] };

/**
 * Renderer identification contract (Phase 3):
 *   ComponentDefinition → definition `name` → renderer key → implementation.
 * A component definition's `name` IS its renderer key. Names outside the
 * built-in set must render the shared "Unsupported component" fallback
 * instead of crashing the scene.
 */
export const BUILT_IN_RENDERER_KEYS = [
  'Label',
  'CounterPill',
  'Hub',
  'Arrow',
  'LogoCard',
] as const;

export type BuiltInRendererKey = (typeof BUILT_IN_RENDERER_KEYS)[number];

export const isKnownRendererKey = (name: string): boolean =>
  (BUILT_IN_RENDERER_KEYS as readonly string[]).includes(name);

/** Canonical world size shared by the editor canvas and Remotion output. */
export const WORLD = { width: 1600, height: 900 } as const;
