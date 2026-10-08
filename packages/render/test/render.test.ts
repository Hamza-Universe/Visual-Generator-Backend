import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_RENDERER_KEYS,
  buildPaintList,
  buildRenderTree,
  connectorEndpointsFor,
  flattenRenderTree,
  isKnownRendererKey,
  renderStyleFor,
  resolveReference,
} from '../src/index.js';
import type { RenderableDocument, RenderableInstance } from '../src/index.js';

const inst = (overrides: Partial<RenderableInstance> = {}): RenderableInstance => ({
  id: `i-${Math.random().toString(36).slice(2)}`,
  props: {},
  position: { x: 0, y: 0 },
  size: { width: 100, height: 100 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 },
  style: { opacity: 1 },
  visible: true,
  zIndex: 0,
  groupId: null,
  ...overrides,
});

const doc = (
  components: RenderableInstance[],
  groups: RenderableDocument['groups'] = [],
): RenderableDocument => ({ components, groups });

describe('render tree', () => {
  it('renders multiple independent instances with stable paint order', () => {
    const f = inst({ id: 'f', zIndex: 0 });
    const eq = inst({ id: 'eq', zIndex: 1 });
    const ma = inst({ id: 'ma', zIndex: 2 });
    const list = buildPaintList(doc([f, eq, ma]));
    expect(list.map((n) => n.instance.id)).toEqual(['f', 'eq', 'ma']);
    expect(list.map((n) => n.paintIndex)).toEqual([0, 1, 2]);
    for (const node of list) {
      expect(node.groupPath).toEqual([]);
      expect(node.depth).toBe(0);
    }
  });

  it('renders nested groups recursively without flattening identity', () => {
    const a = inst({ id: 'a', groupId: 'gb' });
    const b = inst({ id: 'b', groupId: 'gb' });
    const c = inst({ id: 'c', groupId: 'ga' });
    const d = doc(
      [a, b, c],
      [
        { id: 'ga', parentGroupId: null, zIndex: 0 },
        { id: 'gb', parentGroupId: 'ga', zIndex: 0 },
      ],
    );
    const roots = buildRenderTree(d);
    expect(roots).toHaveLength(1);
    expect(roots[0].type).toBe('group');
    const flat = flattenRenderTree(roots);
    expect(flat.map((n) => n.instance.id).sort()).toEqual(['a', 'b', 'c']);
    const gbNode = flat.find((n) => n.instance.id === 'a');
    expect(gbNode?.groupPath).toEqual(['ga', 'gb']);
    expect(gbNode?.depth).toBe(2);
  });

  it('excludes hidden instances and hidden-group subtrees', () => {
    const seen = inst({ id: 'seen' });
    const hidden = inst({ id: 'hidden', visible: false });
    const grouped = inst({ id: 'grouped', groupId: 'g' });
    const d = doc(
      [seen, hidden, grouped],
      [{ id: 'g', parentGroupId: null, zIndex: 0 }],
    );
    expect(buildPaintList(d).map((n) => n.instance.id)).toEqual(['seen', 'grouped']);
    expect(
      buildPaintList(d, { isGroupVisible: () => false }).map((n) => n.instance.id),
    ).toEqual(['seen']);
  });

  it('treats opacity 0 as transparent, not hidden', () => {
    const ghost = inst({ id: 'ghost', style: { opacity: 0 } });
    const list = buildPaintList(doc([ghost]));
    expect(list).toHaveLength(1);
    expect(list[0].style.opacity).toBe(0);
  });

  it('renders nowhere for dangling group ids, like the editor', () => {
    const orphan = inst({ id: 'orphan', groupId: 'missing' });
    expect(buildPaintList(doc([orphan]))).toEqual([]);
  });

  it('orders z-index deterministically with stable ties', () => {
    const low = inst({ id: 'low', zIndex: 1 });
    const high = inst({ id: 'high', zIndex: 9 });
    const tieA = inst({ id: 'tie-a', zIndex: 5 });
    const tieB = inst({ id: 'tie-b', zIndex: 5 });
    // input order tie-b, tie-a, high, low → ties keep document order
    const list = buildPaintList(doc([tieB, tieA, high, low]));
    expect(list.map((n) => n.instance.id)).toEqual(['low', 'tie-b', 'tie-a', 'high']);
  });

  it('is deterministic across repeated builds', () => {
    const d = doc(
      [inst({ id: 'a', zIndex: 2 }), inst({ id: 'b', groupId: 'g', zIndex: 2 })],
      [{ id: 'g', parentGroupId: null, zIndex: 1 }],
    );
    expect(buildPaintList(d)).toEqual(buildPaintList(d));
    expect(buildRenderTree(d)).toEqual(buildRenderTree(d));
  });

  it('never mutates the input document', () => {
    const d = doc([inst({ id: 'a' })], [{ id: 'g', parentGroupId: null, zIndex: 0 }]);
    const before = JSON.stringify(d);
    buildPaintList(d);
    buildRenderTree(d);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('render style', () => {
  it('interprets position/size/transform/opacity/zIndex canonically', () => {
    const style = renderStyleFor(
      inst({
        position: { x: 100, y: 200 },
        size: { width: 400, height: 200 },
        transform: { rotation: 30, scaleX: 2, scaleY: 0.5 },
        style: { opacity: 0.5 },
        zIndex: 7,
      }),
    );
    expect(style).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 200,
      opacity: 0.5,
      transform: 'rotate(30deg) scale(2, 0.5)',
      zIndex: 7,
    });
  });
});

describe('references', () => {
  it('resolves instance ids and follows moved components', () => {
    const f = inst({ id: 'f', position: { x: 100, y: 100 } });
    const ma = inst({ id: 'ma', position: { x: 300, y: 100 } });
    const arrow = inst({ id: 'arrow', props: { from: 'f', to: 'ma' } });
    const components = [f, ma, arrow];
    expect(resolveReference(components, 'f')).toBe(f);
    const before = connectorEndpointsFor(components, arrow);
    expect(before).toEqual({ p1: { x: 200, y: 150 }, p2: { x: 300, y: 150 } });
    const moved = { ...f, position: { x: 0, y: 400 } };
    const after = connectorEndpointsFor([moved, ma, arrow], arrow);
    expect(after).not.toEqual(before);
    expect(after?.p1).toEqual({ x: 100, y: 400 });
  });

  it('returns null for missing references instead of crashing', () => {
    const arrow = inst({ id: 'arrow', props: { from: 'gone', to: '' } });
    expect(connectorEndpointsFor([arrow], arrow)).toBeNull();
  });
});

describe('renderer keys', () => {
  it('knows the built-in set and rejects unknown names', () => {
    expect([...BUILT_IN_RENDERER_KEYS]).toEqual([
      'Label',
      'CounterPill',
      'Hub',
      'Arrow',
      'LogoCard',
    ]);
    for (const key of BUILT_IN_RENDERER_KEYS) expect(isKnownRendererKey(key)).toBe(true);
    expect(isKnownRendererKey('concept-node')).toBe(false);
  });
});
