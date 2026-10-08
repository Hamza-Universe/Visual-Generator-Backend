import { describe, expect, it } from 'vitest';
import {
  applyLayout,
  boxesIntersect,
  instanceText,
  isIntentionalOverlap,
  measureTextSize,
  resolveLayout,
} from '../src/index.js';
import type {
  LayoutChange,
  LayoutDocument,
  LayoutInstance,
  LayoutIntent,
  LayoutRequest,
} from '../src/index.js';

/**
 * Stage 4C — deterministic layout & visual composition engine.
 *
 * These tests pin the layout algorithms, intentional-overlap/layering rules,
 * group & connector awareness, text-aware sizing, canvas constraints,
 * bounded collision resolution, and byte-level determinism.
 */

const inst = (id: string, overrides: Partial<LayoutInstance> = {}): LayoutInstance => ({
  id,
  props: {},
  position: { x: 0, y: 0 },
  size: { width: 100, height: 50 },
  visible: true,
  zIndex: 0,
  groupId: null,
  ...overrides,
});

const doc = (
  components: LayoutInstance[],
  groups: LayoutDocument['groups'] = [],
): LayoutDocument => ({ components, groups });

const run = (
  document: LayoutDocument,
  targets: string[],
  intent: LayoutIntent,
  extra: Partial<LayoutRequest> = {},
) => resolveLayout({ document, targets, intent, ...extra });

/** Apply emitted changes onto a fresh document (mirrors the apply path). */
const withChanges = (
  document: LayoutDocument,
  changes: LayoutChange[],
): LayoutDocument => {
  const byChange = new Map(changes.map((change) => [change.id, change]));
  return {
    ...document,
    components: document.components.map((component) => {
      const change = byChange.get(component.id);
      if (!change) return component;
      return {
        ...component,
        position: change.position,
        size: change.size ?? component.size,
      };
    }),
  };
};

// ---------------------------------------------------------------------------
// Target resolution & determinism
// ---------------------------------------------------------------------------

describe('layout engine — target resolution & determinism', () => {
  it('dedupes targets, normalizes to document order, and warns on missing ids', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 } }),
      inst('b', { position: { x: 300, y: 0 } }),
      inst('c', { position: { x: 600, y: 0 } }),
    ]);
    const r = run(d, ['c', 'ghost', 'c', 'a'], { type: 'horizontal', gap: 10 });
    expect(r.order).toEqual(['a', 'c']);
    expect(r.warnings).toEqual(['missing-target:ghost']);
    // b is not a target; a already sits at the union origin → only c moves.
    expect(r.changes.map((c) => c.id)).toEqual(['c']);
  });

  it('never mutates the document and is byte-identical across runs', () => {
    const d = doc([
      inst('a', { position: { x: 900, y: 700 } }),
      inst('b', { position: { x: 12, y: 34 } }),
      inst('c', { position: { x: 500, y: 500 }, size: { width: 70, height: 90 } }),
    ]);
    const before = JSON.stringify(d);
    const r1 = run(d, ['a', 'b', 'c'], { type: 'grid', columns: 2 });
    const r2 = run(d, ['c', 'b', 'a', 'c'], { type: 'grid', columns: 2 });
    expect(JSON.stringify(d)).toBe(before);
    expect(r2).toEqual(r1);
    expect(r1.changes).toHaveLength(3);
  });

  it('lays out hidden instances too (visibility is not geometry)', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 } }),
      inst('h', { position: { x: 300, y: 0 }, visible: false }),
    ]);
    const r = run(d, ['a', 'h'], { type: 'horizontal', gap: 10 });
    expect(r.changes).toEqual([{ id: 'h', position: { x: 110, y: 0 } }]);
  });

  it('emits nothing when the requested layout already holds', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 } }),
      inst('b', { position: { x: 110, y: 0 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'horizontal', gap: 10 });
    expect(r.changes).toEqual([]);
  });

  it('exports applyLayout as an alias of resolveLayout', () => {
    expect(applyLayout).toBe(resolveLayout);
  });
});

// ---------------------------------------------------------------------------
// Packing algorithms
// ---------------------------------------------------------------------------

describe('packing algorithms', () => {
  it('packs a horizontal row inside the targets’ union box with minimal changes', () => {
    const d = doc([
      inst('a', { position: { x: 10, y: 10 }, size: { width: 100, height: 40 } }),
      inst('b', { position: { x: 500, y: 200 }, size: { width: 80, height: 60 } }),
      inst('c', { position: { x: 300, y: 50 }, size: { width: 60, height: 20 } }),
    ]);
    const r = run(d, ['c', 'a', 'b'], { type: 'horizontal', gap: 20 });
    expect(r.order).toEqual(['a', 'b', 'c']);
    // union = {x:10,y:10,w:570,h:250}; a already sits at the origin → untouched.
    expect(r.changes).toEqual([
      { id: 'b', position: { x: 130, y: 10 } },
      { id: 'c', position: { x: 230, y: 10 } },
    ]);
  });

  it('honours justify/align against an explicit canvas container', () => {
    const d = doc([
      inst('a', { size: { width: 100, height: 40 } }),
      inst('b', { position: { x: 700, y: 400 }, size: { width: 80, height: 60 } }),
      inst('c', { position: { x: 50, y: 300 }, size: { width: 60, height: 20 } }),
    ]);
    const r = run(
      d,
      ['a', 'b', 'c'],
      {
        type: 'horizontal',
        gap: 20,
        justify: 'center',
        align: 'center',
        container: { kind: 'canvas' },
      },
      { canvas: { width: 400, height: 300 } },
    );
    // total = 280 → x0 = (400−280)/2 = 60; each item vertically centered.
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 60, y: 130 } },
      { id: 'b', position: { x: 180, y: 120 } },
      { id: 'c', position: { x: 280, y: 140 } },
    ]);
  });

  it('packs a vertical column with cross-axis alignment', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 40 } }),
      inst('b', { position: { x: 400, y: 400 }, size: { width: 80, height: 60 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'vertical', gap: 10 });
    expect(r.changes).toEqual([{ id: 'b', position: { x: 0, y: 50 } }]);
  });

  it('lays a grid out in uniform cells with explicit columns', () => {
    const d = doc([
      inst('a', { position: { x: 900, y: 700 } }),
      inst('b', { position: { x: 10, y: 10 } }),
      inst('c', { position: { x: 500, y: 500 } }),
      inst('d', { position: { x: 100, y: 900 } }),
    ]);
    const r = run(
      d,
      ['a', 'b', 'c', 'd'],
      {
        type: 'grid',
        columns: 2,
        gapX: 10,
        gapY: 10,
        container: { kind: 'canvas' },
      },
    );
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 110, y: 0 } },
      { id: 'c', position: { x: 0, y: 60 } },
      { id: 'd', position: { x: 110, y: 60 } },
    ]);
  });

  it('defaults grid columns to ceil(sqrt(n))', () => {
    const d = doc([
      inst('a'),
      inst('b', { position: { x: 900, y: 700 } }),
      inst('c', { position: { x: 500, y: 500 } }),
    ]);
    const r = run(
      d,
      ['a', 'b', 'c'],
      { type: 'grid', container: { kind: 'canvas' } },
    );
    // 3 items → 2 columns → c starts row 1 (y = cellH + gapY = 50 + 16).
    const c = r.changes.find((change) => change.id === 'c');
    expect(c?.position).toEqual({ x: 0, y: 66 });
  });
});

// ---------------------------------------------------------------------------
// Composition: center / stack (deliberate overlays)
// ---------------------------------------------------------------------------

describe('composition algorithms', () => {
  it('centers the target block on the default WORLD canvas', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 200, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'center' });
    // union {0,0,300,50} → center (150,25) → canvas center (800,450): dx650 dy425.
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 650, y: 425 } },
      { id: 'b', position: { x: 850, y: 425 } },
    ]);
  });

  it('centers each instance on one point as a deliberate overlay', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 200, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(
      d,
      ['a', 'b'],
      { type: 'center', mode: 'each', container: { kind: 'canvas' } },
      { canvas: { width: 400, height: 300 }, reportOverlaps: true },
    );
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 150, y: 125 } },
      { id: 'b', position: { x: 150, y: 125 } },
    ]);
    expect(r.overlaps).toEqual([{ a: 'a', b: 'b', intentional: true }]);
  });

  it('stacks instances on one point — intentional overlap, never separated', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 200, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'stack' }, { reportOverlaps: true });
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 100, y: 0 } },
      { id: 'b', position: { x: 100, y: 0 } },
    ]);
    expect(r.overlaps).toEqual([{ a: 'a', b: 'b', intentional: true }]);
  });

  it('equalizes stacked sizes to the largest target', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 200, y: 0 }, size: { width: 200, height: 100 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'stack', equalizeSize: true });
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 100, y: 0 }, size: { width: 200, height: 100 } },
      { id: 'b', position: { x: 100, y: 0 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Align & distribute
// ---------------------------------------------------------------------------

describe('align & distribute', () => {
  it('aligns edges to the targets’ own union box (self-align)', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 10 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 50, y: 20 }, size: { width: 80, height: 60 } }),
      inst('c', { position: { x: 100, y: 30 }, size: { width: 60, height: 40 } }),
    ]);
    const r = run(d, ['a', 'b', 'c'], { type: 'align', axis: 'x', mode: 'min' });
    expect(r.changes).toEqual([
      { id: 'b', position: { x: 0, y: 20 } },
      { id: 'c', position: { x: 0, y: 30 } },
    ]);
  });

  it('aligns centers to a union box center', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 200, y: 0 }, size: { width: 80, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'align', axis: 'x', mode: 'center' });
    // union width 280 → center x = 140 → a → 90, b → 100.
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 90, y: 0 } },
      { id: 'b', position: { x: 100, y: 0 } },
    ]);
  });

  it('aligns to an explicit instance container', () => {
    const d = doc([
      inst('card', { position: { x: 400, y: 400 }, size: { width: 300, height: 200 } }),
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 200, y: 0 }, size: { width: 80, height: 50 } }),
    ]);
    const r = run(
      d,
      ['a', 'b'],
      {
        type: 'align',
        axis: 'x',
        mode: 'center',
        container: { kind: 'instance', instanceId: 'card' },
      },
    );
    expect(r.changes).toEqual([
      { id: 'a', position: { x: 500, y: 0 } },
      { id: 'b', position: { x: 510, y: 0 } },
    ]);
  });

  it('aligns the bottom edges on the y axis', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 0, y: 100 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'align', axis: 'y', mode: 'max' });
    // union {0,0,100,150} → bottom = 150 → y = 100 for both; b already there.
    expect(r.changes).toEqual([{ id: 'a', position: { x: 0, y: 100 } }]);
  });

  it('distributes even edge gaps while first and last keep their positions', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 250, y: 0 }, size: { width: 100, height: 50 } }),
      inst('c', { position: { x: 600, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['c', 'b', 'a'], { type: 'distribute', axis: 'x' });
    // gap = (700 − 0 − 300) / 2 = 200 → b → x = 300; a and c untouched.
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.changes).toEqual([{ id: 'b', position: { x: 300, y: 0 } }]);
  });

  it('distributes on the y axis', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 0, y: 250 }, size: { width: 100, height: 50 } }),
      inst('c', { position: { x: 0, y: 600 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b', 'c'], { type: 'distribute', axis: 'y' });
    // gap = (650 − 0 − 150)/2 = 250 → b → y = 300.
    expect(r.changes).toEqual([{ id: 'b', position: { x: 0, y: 300 } }]);
  });

  it('leaves two targets unchanged when distributing', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 } }),
      inst('b', { position: { x: 400, y: 0 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'distribute', axis: 'x' });
    expect(r.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Relationship flow
// ---------------------------------------------------------------------------

describe('relationship flow', () => {
  const chainScene = () =>
    doc(
      [
        inst('c', { position: { x: 0, y: 600 } }),
        inst('b', { position: { x: 0, y: 300 } }),
        inst('a', { position: { x: 0, y: 0 } }),
        inst('arrow1', {
          props: { from: 'a', to: 'b' },
          position: { x: 700, y: 700 },
          size: { width: 10, height: 10 },
          zIndex: 5,
        }),
        inst('arrow2', {
          props: { from: 'b', to: 'c' },
          position: { x: 700, y: 700 },
          size: { width: 10, height: 10 },
          zIndex: 5,
        }),
      ],
    );

  it('orders nodes topologically and re-anchors connectors to their endpoints', () => {
    const d = chainScene();
    const r = run(
      d,
      ['arrow2', 'a', 'c', 'arrow1', 'b'],
      { type: 'flow' },
      { refProps: ['from', 'to'] },
    );
    // Flow order (a → b → c) differs from document order (c, b, a).
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.warnings).toEqual([]);
    // union {0,0,100,650}; gap default 60: a (0,0) untouched, b → 160, c → 320.
    // Connectors are derived geometry: segment boxes between the final boxes.
    expect(r.changes).toEqual([
      { id: 'c', position: { x: 320, y: 0 } },
      { id: 'b', position: { x: 160, y: 0 } },
      {
        id: 'arrow1',
        position: { x: 100, y: 25 },
        size: { width: 60, height: 1 },
      },
      {
        id: 'arrow2',
        position: { x: 260, y: 25 },
        size: { width: 60, height: 1 },
      },
    ]);
  });

  it('flows vertically when requested', () => {
    const d = chainScene();
    const r = run(
      d,
      ['a', 'b', 'c', 'arrow1', 'arrow2'],
      { type: 'flow', direction: 'vertical' },
      { refProps: ['from', 'to'] },
    );
    expect(r.changes.filter((c) => c.id !== 'arrow1' && c.id !== 'arrow2')).toEqual([
      { id: 'c', position: { x: 0, y: 220 } },
      { id: 'b', position: { x: 0, y: 110 } },
    ]);
  });

  it('falls back to document order with a warning on relationship cycles', () => {
    const d = doc(
      [
        inst('a', { position: { x: 0, y: 0 } }),
        inst('b', { position: { x: 0, y: 300 } }),
        inst('c', { position: { x: 0, y: 600 } }),
        inst('ab', { props: { from: 'a', to: 'b' } }),
        inst('bc', { props: { from: 'b', to: 'c' } }),
        inst('ca', { props: { from: 'c', to: 'a' } }),
      ],
    );
    const r = run(
      d,
      ['a', 'b', 'c', 'ab', 'bc', 'ca'],
      { type: 'flow' },
      { refProps: ['from', 'to'] },
    );
    expect(r.warnings).toContain('flow-cycle');
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.changes.find((change) => change.id === 'b')?.position).toEqual({
      x: 160,
      y: 0,
    });
  });

  it('warns and packs in document order when no reference props exist', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 } }),
      inst('b', { position: { x: 0, y: 300 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'flow' });
    expect(r.warnings).toEqual(['flow-no-refs']);
    expect(r.changes).toEqual([{ id: 'b', position: { x: 160, y: 0 } }]);
  });
});

// ---------------------------------------------------------------------------
// Text-aware sizing
// ---------------------------------------------------------------------------

describe('text-aware sizing', () => {
  it('measures text deterministically without a DOM', () => {
    expect(measureTextSize('Hello', { fontSize: 20 })).toEqual({
      width: 60,
      height: 25,
    });
    expect(measureTextSize('Hello\nWorld!', { fontSize: 10 })).toEqual({
      width: 36,
      height: 25,
    });
    expect(measureTextSize('')).toEqual({ width: 1, height: 20 });
  });

  it('wraps greedily to maxWidth', () => {
    expect(
      measureTextSize('aaa bbb ccc', { fontSize: 10, maxWidth: 40 }),
    ).toEqual({ width: 18, height: 37.5 });
  });

  it('reads the first available text prop', () => {
    expect(instanceText(inst('t', { props: { label: 'L' } }))).toBe('L');
    expect(instanceText(inst('t', { props: { title: 'T' } }))).toBe('T');
    expect(instanceText(inst('t', { props: { text: '  ' } }))).toBe(null);
    expect(instanceText(inst('t'))).toBe(null);
  });

  it('fitText resizes text instances only, keeping positions', () => {
    const d = doc([
      inst('t1', {
        props: { text: 'Hi there' },
        position: { x: 50, y: 60 },
        size: { width: 10, height: 10 },
      }),
      inst('box', { position: { x: 1, y: 2 }, size: { width: 40, height: 40 } }),
    ]);
    const r = run(d, ['t1', 'box'], { type: 'fitText' });
    // 8 chars × 16 × 0.6 = 76.8; line height 16 × 1.25 = 20.
    expect(r.changes).toEqual([
      {
        id: 't1',
        position: { x: 50, y: 60 },
        size: { width: 76.8, height: 20 },
      },
    ]);
  });

  it('fitText honours fontSize props, intent fallbacks, padding, and maxWidth', () => {
    const d = doc([
      inst('big', { props: { text: 'Hi there', fontSize: 24 } }),
      inst('small', { props: { text: 'Hi' } }),
      inst('padded', { props: { text: 'Hi there' } }),
      inst('wrapped', { props: { text: 'aaa bbb ccc', fontSize: 10 } }),
    ]);
    const r1 = run(d, ['big'], { type: 'fitText' });
    expect(r1.changes[0].size).toEqual({ width: 115.2, height: 30 });

    const r2 = run(d, ['small'], { type: 'fitText', fontSize: 10 });
    expect(r2.changes[0].size).toEqual({ width: 12, height: 12.5 });

    const r3 = run(
      d,
      ['padded'],
      { type: 'fitText', paddingX: 5, paddingY: 5 },
    );
    expect(r3.changes[0].size).toEqual({ width: 86.8, height: 30 });

    const r4 = run(d, ['wrapped'], { type: 'fitText', maxWidth: 40 });
    expect(r4.changes[0].size).toEqual({ width: 18, height: 37.5 });
  });
});

// ---------------------------------------------------------------------------
// Canvas constraints
// ---------------------------------------------------------------------------

describe('canvas constraints', () => {
  it('clamps instances fully inside the canvas', () => {
    const d = doc([inst('a', { position: { x: 350, y: 280 }, size: { width: 100, height: 50 } })]);
    const r = run(
      d,
      ['a'],
      { type: 'constrain' },
      { canvas: { width: 400, height: 300 } },
    );
    expect(r.changes).toEqual([{ id: 'a', position: { x: 300, y: 250 } }]);
  });

  it('pins oversized instances to the origin', () => {
    const d = doc([inst('big', { position: { x: 10, y: 10 }, size: { width: 600, height: 400 } })]);
    const r = run(
      d,
      ['big'],
      { type: 'constrain' },
      { canvas: { width: 400, height: 300 } },
    );
    expect(r.changes).toEqual([{ id: 'big', position: { x: 0, y: 0 } }]);
  });
});

// ---------------------------------------------------------------------------
// Overlaps & collision resolution (layered compositions!)
// ---------------------------------------------------------------------------

describe('overlaps & collision resolution', () => {
  it('treats edge-touching boxes as non-overlapping', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(boxesIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(boxesIntersect(a, { x: 0, y: 10, width: 10, height: 10 })).toBe(false);
    expect(boxesIntersect(a, { x: 9, y: 0, width: 10, height: 10 })).toBe(true);
  });

  it('detects overlaps in target and scene scope without touching geometry', () => {
    const d = doc([
      inst('a', { size: { width: 100, height: 100 } }),
      inst('b', { position: { x: 50, y: 0 }, size: { width: 100, height: 100 } }),
      inst('c', { position: { x: 500, y: 500 }, size: { width: 10, height: 10 } }),
      inst('d', { position: { x: 20, y: 20 }, size: { width: 100, height: 100 } }),
    ]);
    const targets = ['a', 'b', 'c'];
    const scoped = run(d, targets, { type: 'detectOverlaps' });
    expect(scoped.changes).toEqual([]);
    expect(scoped.overlaps).toEqual([{ a: 'a', b: 'b', intentional: false }]);

    const scene = run(d, targets, { type: 'detectOverlaps', scope: 'scene' });
    expect(scene.overlaps).toEqual([
      { a: 'a', b: 'b', intentional: false },
      { a: 'a', b: 'd', intentional: false },
      { a: 'b', b: 'd', intentional: false },
    ]);
  });

  it('reports style-marked overlaps as intentional', () => {
    const marked = {
      ...inst('b', { position: { x: 50, y: 0 }, size: { width: 100, height: 100 } }),
      style: { opacity: 1, layoutOverlap: 'intentional' },
    };
    const d = doc([inst('a', { size: { width: 100, height: 100 } }), marked]);
    expect(isIntentionalOverlap(marked)).toBe(true);
    expect(isIntentionalOverlap(inst('plain'))).toBe(false);
    const r = run(d, ['a', 'b'], { type: 'detectOverlaps' });
    expect(r.overlaps).toEqual([{ a: 'a', b: 'b', intentional: true }]);
  });

  it('never separates overlapping boxes implicitly (layered composition)', () => {
    const d = doc([
      inst('a', { size: { width: 100, height: 100 } }),
      inst('b', { position: { x: 50, y: 0 }, size: { width: 100, height: 100 } }),
    ]);
    // A layout pass that has nothing to move must not “fix” the overlap.
    const r = run(d, ['a', 'b'], { type: 'constrain' });
    expect(r.changes).toEqual([]);
    const after = run(d, ['a', 'b'], { type: 'detectOverlaps' });
    expect(after.overlaps).toHaveLength(1);
  });

  it('resolves collisions deterministically along the minimum-overlap axis', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 50, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'resolveCollisions' });
    expect(r.warnings).toEqual([]);
    expect(r.changes).toEqual([{ id: 'b', position: { x: 100.01, y: 0 } }]);

    const settled = withChanges(d, r.changes);
    const check = run(settled, ['a', 'b'], { type: 'detectOverlaps' });
    expect(check.overlaps).toEqual([]);
  });

  it('exempts intentional (style-marked) overlaps from resolution', () => {
    const d = doc([
      inst('a', { size: { width: 100, height: 100 } }),
      inst('b', {
        position: { x: 50, y: 0 },
        size: { width: 100, height: 100 },
        style: { opacity: 1, layoutOverlap: 'intentional' },
      }),
    ]);
    const r = run(d, ['a', 'b'], { type: 'resolveCollisions' });
    expect(r.changes).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('converges for chained overlaps within the default pass bound', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 50, y: 0 }, size: { width: 100, height: 50 } }),
      inst('c', { position: { x: 100, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b', 'c'], { type: 'resolveCollisions' });
    expect(r.warnings).toEqual([]);
    expect(r.changes).toEqual([
      { id: 'b', position: { x: 100.01, y: 0 } },
      { id: 'c', position: { x: 100, y: 50.01 } },
    ]);
    const settled = withChanges(d, r.changes);
    expect(run(settled, ['a', 'b', 'c'], { type: 'detectOverlaps' }).overlaps).toEqual(
      [],
    );
  });

  it('warns instead of looping when the pass bound is exhausted', () => {
    const d = doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 50, y: 0 }, size: { width: 100, height: 50 } }),
      inst('c', { position: { x: 100, y: 0 }, size: { width: 100, height: 50 } }),
    ]);
    const r = run(d, ['a', 'b', 'c'], { type: 'resolveCollisions', maxPasses: 1 });
    expect(r.warnings).toEqual(['collision-resolution-exceeded']);
    expect(r.changes).toEqual([{ id: 'b', position: { x: 100.01, y: 0 } }]);
  });

  it('caps the overlap report and says so', () => {
    const boxes = Array.from({ length: 21 }, (_, index) =>
      inst(`n${index}`, { size: { width: 100, height: 100 } }),
    );
    const d = doc(boxes);
    const r = run(
      d,
      boxes.map((b) => b.id),
      { type: 'detectOverlaps' },
    );
    expect(r.overlaps).toHaveLength(200);
    expect(r.warnings).toEqual(['overlaps-truncated']);
  });
});

// ---------------------------------------------------------------------------
// Groups & containers
// ---------------------------------------------------------------------------

describe('groups & containers', () => {
  const groupScene = () =>
    doc(
      [
        inst('m1', { position: { x: 0, y: 0 }, groupId: 'g' }),
        inst('m2', { position: { x: 0, y: 100 }, groupId: 'g2' }),
        inst('out', {
          position: { x: 400, y: 400 },
          size: { width: 100, height: 100 },
          groupId: 'g',
        }),
        inst('lone', { position: { x: 900, y: 900 }, groupId: null }),
      ],
      [
        { id: 'g', parentGroupId: null, zIndex: 0 },
        { id: 'g2', parentGroupId: 'g', zIndex: 1 },
      ],
    );

  it('uses the union of nested group members as the container', () => {
    const r = run(
      groupScene(),
      ['m1', 'm2'],
      {
        type: 'horizontal',
        gap: 10,
        container: { kind: 'group', groupId: 'g' },
      },
    );
    // members of g (incl. subgroup g2): m1, m2, out → union {0,0,500,500};
    // only the targeted members move — out and lone stay put.
    expect(r.changes).toEqual([{ id: 'm2', position: { x: 110, y: 0 } }]);
  });

  it('warns when a group container is empty and falls back', () => {
    const r = run(
      groupScene(),
      ['m1', 'm2'],
      {
        type: 'horizontal',
        gap: 10,
        container: { kind: 'group', groupId: 'ghost' },
      },
    );
    expect(r.warnings).toContain('container-empty');
    expect(r.changes).toEqual([{ id: 'm2', position: { x: 110, y: 0 } }]);
  });

  it('warns when an instance container cannot be found', () => {
    const r = run(
      groupScene(),
      ['m1', 'm2'],
      {
        type: 'horizontal',
        gap: 10,
        container: { kind: 'instance', instanceId: 'ghost' },
      },
    );
    expect(r.warnings).toContain('container-not-found');
    expect(r.changes).toEqual([{ id: 'm2', position: { x: 110, y: 0 } }]);
  });
});

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

describe('connectors', () => {
  const connectorScene = () =>
    doc([
      inst('a', { position: { x: 0, y: 0 }, size: { width: 100, height: 50 } }),
      inst('b', { position: { x: 300, y: 200 }, size: { width: 100, height: 50 } }),
      inst('arrow', {
        props: { from: 'a', to: 'b' },
        position: { x: 700, y: 700 },
        size: { width: 10, height: 10 },
        zIndex: 5,
      }),
      inst('dangling', {
        props: { from: 'ghost', to: 'b' },
        position: { x: 800, y: 800 },
        size: { width: 10, height: 10 },
        zIndex: 5,
      }),
    ]);

  it('excludes connectors from packing and re-anchors them to the segment', () => {
    const r = run(
      connectorScene(),
      ['a', 'b', 'arrow'],
      { type: 'horizontal', gap: 20 },
      { refProps: ['from', 'to'] },
    );
    // b → x=120; the arrow becomes the segment box between a and b,
    // NOT the third slot of the row (x=240) — it is derived geometry.
    expect(r.changes).toEqual([
      { id: 'b', position: { x: 120, y: 0 } },
      {
        id: 'arrow',
        position: { x: 100, y: 25 },
        size: { width: 20, height: 1 },
      },
    ]);
  });

  it('leaves dangling connectors untouched', () => {
    const r = run(
      connectorScene(),
      ['a', 'b', 'arrow', 'dangling'],
      { type: 'horizontal', gap: 20 },
      { refProps: ['from', 'to'] },
    );
    expect(r.changes.some((change) => change.id === 'dangling')).toBe(false);
  });

  it('marks connector↔endpoint overlaps as intentional', () => {
    const d = doc([
      inst('a', { size: { width: 200, height: 100 } }),
      inst('b', { position: { x: 50, y: 50 }, size: { width: 200, height: 100 } }),
      inst('arrow', {
        props: { from: 'a', to: 'b' },
        size: { width: 200, height: 100 },
      }),
    ]);
    const r = run(d, ['a', 'b', 'arrow'], { type: 'detectOverlaps', scope: 'scene' }, {
      refProps: ['from', 'to'],
    });
    expect(r.overlaps).toEqual([
      { a: 'a', b: 'b', intentional: false },
      { a: 'a', b: 'arrow', intentional: true },
      { a: 'b', b: 'arrow', intentional: true },
    ]);
  });

  it('does not rewrite geometry for read-only detectOverlaps', () => {
    const d = connectorScene();
    const before = JSON.stringify(d);
    const r = run(d, ['a', 'b', 'arrow'], { type: 'detectOverlaps' }, {
      refProps: ['from', 'to'],
    });
    expect(r.changes).toEqual([]);
    expect(JSON.stringify(d)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Warning bounds
// ---------------------------------------------------------------------------

describe('warnings', () => {
  it('bounds warnings and appends a truncation marker', () => {
    const ghosts = Array.from({ length: 30 }, (_, index) => `ghost-${index}`);
    const r = run(doc([inst('a')]), ghosts, { type: 'horizontal' });
    expect(r.warnings).toHaveLength(21);
    expect(r.warnings[20]).toBe('warnings-truncated');
  });
});
