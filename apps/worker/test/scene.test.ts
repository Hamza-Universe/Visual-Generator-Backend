import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SceneComposition, resolveSceneRenderer } from '../src/remotion/scene.js';
import type { SceneCompositionProps } from '../src/remotion/scene.js';

const LABEL_DEF = '00000000-0000-4000-8000-000000000001';
const ARROW_DEF = '00000000-0000-4000-8000-000000000002';

const inst = (overrides: Record<string, unknown> = {}) => ({
  id: `i-${Math.random().toString(36).slice(2)}`,
  componentDefinitionId: LABEL_DEF,
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

const definitions = { [LABEL_DEF]: 'Label', [ARROW_DEF]: 'Arrow' };

const markup = (props: Partial<SceneCompositionProps> & { document: SceneCompositionProps['document'] }) =>
  renderToStaticMarkup(
    createElement(SceneComposition, {
      definitions,
      ...props,
    } as SceneCompositionProps),
  );

const lineAttrs = (html: string) => {
  const line = html.match(/<line[^>]*>/)?.[0] ?? '';
  const attr = (name: string) => line.match(new RegExp(`${name}="([^"]+)"`))?.[1];
  return { x1: attr('x1'), y1: attr('y1'), x2: attr('x2'), y2: attr('y2') };
};

describe('SceneComposition', () => {
  it('renders F, =, ma as independent instances', () => {
    const html = markup({
      document: {
        components: [
          inst({ id: 'f', props: { text: 'F' } }),
          inst({ id: 'eq', props: { text: '=' } }),
          inst({ id: 'ma', props: { text: 'ma' } }),
        ],
        groups: [],
      },
    });
    for (const id of ['f', 'eq', 'ma']) {
      expect(html).toContain(`data-instance-id="${id}"`);
    }
    expect(html).toContain('>F<');
    expect(html).toContain('>ma<');
  });

  it('renders nested groups with all descendants', () => {
    const html = markup({
      document: {
        components: [
          inst({ id: 'a', groupId: 'gb' }),
          inst({ id: 'b', groupId: 'gb' }),
          inst({ id: 'c', groupId: 'ga' }),
        ],
        groups: [
          { id: 'ga', parentGroupId: null, zIndex: 0 },
          { id: 'gb', parentGroupId: 'ga', zIndex: 0 },
        ],
      },
    });
    for (const id of ['a', 'b', 'c']) {
      expect(html).toContain(`data-instance-id="${id}"`);
    }
    expect(html).toContain('data-group-id="ga"');
    expect(html).toContain('data-group-id="gb"');
    // hierarchy preserved: gb nested inside ga
    const gaAt = html.indexOf('data-group-id="ga"');
    const gbAt = html.indexOf('data-group-id="gb"');
    expect(gbAt).toBeGreaterThan(gaAt);
  });

  it('skips hidden instances but renders opacity-0 ones', () => {
    const html = markup({
      document: {
        components: [
          inst({ id: 'hidden', visible: false }),
          inst({ id: 'ghost', style: { opacity: 0 } }),
        ],
        groups: [],
      },
    });
    expect(html).not.toContain('data-instance-id="hidden"');
    expect(html).toContain('data-instance-id="ghost"');
    expect(html).toContain('opacity:0');
  });

  it('interprets position/size/transform consistently', () => {
    const html = markup({
      document: {
        components: [
          inst({
            id: 't',
            position: { x: 100, y: 200 },
            size: { width: 400, height: 200 },
            transform: { rotation: 30, scaleX: 2, scaleY: 0.5 },
            style: { opacity: 0.5 },
            zIndex: 7,
          }),
        ],
        groups: [],
      },
    });
    expect(html).toContain('left:100px');
    expect(html).toContain('top:200px');
    expect(html).toContain('width:400px');
    expect(html).toContain('transform:rotate(30deg) scale(2, 0.5)');
    expect(html).toContain('z-index:7');
  });

  it('stacks higher layers above lower ones', () => {
    const html = markup({
      document: {
        components: [
          inst({ id: 'back', zIndex: 1 }),
          inst({ id: 'front', zIndex: 9 }),
          inst({ id: 'middle', zIndex: 5 }),
        ],
        groups: [],
      },
    });
    const order = ['back', 'middle', 'front'].map((id) => html.indexOf(`data-instance-id="${id}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('resolves arrow references between instances', () => {
    const html = markup({
      document: {
        components: [
          inst({ id: 'f', position: { x: 100, y: 100 } }),
          inst({ id: 'ma', position: { x: 300, y: 100 } }),
          inst({
            id: 'arrow',
            componentDefinitionId: ARROW_DEF,
            props: { from: 'f', to: 'ma' },
          }),
        ],
        groups: [],
      },
    });
    expect(lineAttrs(html)).toEqual({ x1: '200', y1: '150', x2: '300', y2: '150' });
  });

  it('moves the arrow endpoint when a referenced component moves', () => {
    const base = {
      components: [
        inst({ id: 'f', position: { x: 100, y: 100 } }),
        inst({ id: 'ma', position: { x: 300, y: 100 } }),
        inst({
          id: 'arrow',
          componentDefinitionId: ARROW_DEF,
          props: { from: 'f', to: 'ma' },
        }),
      ],
      groups: [],
    };
    const before = lineAttrs(markup({ document: base }));
    const after = lineAttrs(
      markup({
        document: {
          ...base,
          components: base.components.map((c) =>
            c.id === 'f' ? { ...c, position: { x: 0, y: 400 } } : c,
          ),
        },
      }),
    );
    expect(after).not.toEqual(before);
    expect(after.x1).toBe('100');
  });

  it('renders a safe fallback for missing references', () => {
    const html = markup({
      document: {
        components: [
          inst({
            id: 'arrow',
            componentDefinitionId: ARROW_DEF,
            props: { from: 'gone', to: '' },
          }),
        ],
        groups: [],
      },
    });
    expect(lineAttrs(html).x1).toBe('8');
  });

  it('renders the unsupported fallback for unknown components', () => {
    const html = markup({
      document: { components: [inst({ id: 'weird' })], groups: [] },
      definitions: { [LABEL_DEF]: 'concept-node' },
    });
    expect(html).toContain('Unsupported component');
    expect(html).toContain('concept-node');
  });

  it('is deterministic for the same document', () => {
    const document = {
      components: [
        inst({ id: 'a', zIndex: 2 }),
        inst({ id: 'b', groupId: 'g', zIndex: 2 }),
      ],
      groups: [{ id: 'g', parentGroupId: null, zIndex: 1 }],
    };
    expect(markup({ document })).toBe(markup({ document }));
  });

  it('resolves built-in renderer keys and nothing else', () => {
    for (const key of ['Label', 'CounterPill', 'Hub', 'Arrow', 'LogoCard']) {
      expect(resolveSceneRenderer(key)).not.toBeNull();
    }
    expect(resolveSceneRenderer('concept-node')).toBeNull();
  });
});
