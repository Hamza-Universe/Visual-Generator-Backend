import { boundsOf } from './geometry.js';
import type {
  RenderableDocument,
  RenderableGroup,
  RenderableInstance,
  RenderNode,
  RenderTreeNode,
} from './types.js';
import { renderStyleFor } from './style.js';

export interface BuildTreeOptions {
  /**
   * Group visibility predicate. Groups have no visibility field in the
   * document model, so this defaults to always-visible. When provided
   * (e.g. future group hiding), a hidden group excludes its whole subtree —
   * deterministically, on every renderer.
   */
  isGroupVisible?: (groupId: string) => boolean;
}

/** Stable ascending z-order. Ties keep document order on every renderer. */
const stableSortByZ = <T extends { zIndex: number }>(items: T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.zIndex - b.item.zIndex || a.index - b.index)
    .map(({ item }) => item);

/**
 * Deterministic render tree for a SceneDocument (Stage 2D, Phases 5/8/9).
 *
 * Mirrors the editor's paint structure exactly:
 *   top-level instances (z-order) then top-level groups (z-order),
 *   each group rendering child instances (z-order) then child groups,
 *   recursively. Instances with a dangling groupId render nowhere —
 *   same as the editor. Invisible instances are excluded; hidden groups
 *   exclude their whole subtree. Never mutates the document.
 */
export const buildRenderTree = <TInstance extends RenderableInstance>(
  document: { components: TInstance[]; groups: RenderableGroup[] },
  opts: BuildTreeOptions = {},
): RenderTreeNode<TInstance>[] => {
  const isGroupVisible = opts.isGroupVisible ?? (() => true);
  const groupById = new Map(document.groups.map((g) => [g.id, g]));
  const groupRendered = (group: RenderableGroup): boolean => {
    if (!isGroupVisible(group.id)) return false;
    if (!group.parentGroupId) return true;
    const parent = groupById.get(group.parentGroupId);
    return parent ? groupRendered(parent) : false;
  };

  let paintIndex = 0;
  const instanceNode = (
    instance: TInstance,
    groupPath: string[],
  ): RenderTreeNode<TInstance> => ({
    type: 'instance',
    node: {
      instance,
      groupPath,
      depth: groupPath.length,
      paintIndex: paintIndex++,
      bounds: boundsOf(instance),
      style: renderStyleFor(instance),
    },
  });

  const groupNode = (group: RenderableGroup, path: string[]): RenderTreeNode<TInstance> => ({
    type: 'group',
    group,
    children: [
      ...stableSortByZ(
        document.components.filter((c) => c.visible && c.groupId === group.id),
      ).map((c) => instanceNode(c, [...path, group.id])),
      ...stableSortByZ(
        document.groups.filter((g) => g.parentGroupId === group.id && groupRendered(g)),
      ).map((g) => groupNode(g, [...path, group.id])),
    ],
  });

  return [
    ...stableSortByZ(
      document.components.filter((c) => c.visible && !c.groupId),
    ).map((c) => instanceNode(c, [])),
    ...stableSortByZ(
      document.groups.filter((g) => !g.parentGroupId && groupRendered(g)),
    ).map((g) => groupNode(g, [])),
  ];
};

/** Depth-first flattening of a render tree = deterministic paint order. */
export const flattenRenderTree = <TInstance extends RenderableInstance>(
  roots: RenderTreeNode<TInstance>[],
): RenderNode<TInstance>[] => {
  const out: RenderNode<TInstance>[] = [];
  const visit = (node: RenderTreeNode<TInstance>): void => {
    if (node.type === 'instance') out.push(node.node);
    else for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
};

/** Convenience: flattened paint list for a document in one call. */
export const buildPaintList = <TInstance extends RenderableInstance>(
  document: { components: TInstance[]; groups: RenderableGroup[] },
  opts: BuildTreeOptions = {},
): RenderNode<TInstance>[] => flattenRenderTree(buildRenderTree(document, opts));
