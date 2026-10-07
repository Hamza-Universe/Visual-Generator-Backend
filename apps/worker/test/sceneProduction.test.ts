import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  buildRenderTree,
  connectorEndpointsFor,
  evaluateSceneAtFrame,
  flattenRenderTree,
  resolveTimeline,
} from '@app/render';
import { SceneComposition } from '../src/remotion/scene.js';
import type { SceneCompositionProps } from '../src/remotion/scene.js';
import { SceneProductionComposition } from '../src/remotion/sceneProduction.js';

vi.mock('remotion', () => ({ useCurrentFrame: () => 30 }));

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

const productionMarkup = (
  document: SceneCompositionProps['document'],
  defs: Record<string, string> = definitions,
) =>
  renderToStaticMarkup(
    createElement(SceneProductionComposition, { document, definitions: defs }),
  );

const previewMarkup = (
  document: SceneCompositionProps['document'],
  frame: number,
) =>
  renderToStaticMarkup(
    createElement(SceneComposition, { document, definitions, frame } as SceneCompositionProps),
  );

const track = (property: string, keyframes: Array<{ frame: number; value: number; easing?: string }>) => ({
  property,
  keyframes,
});

/** Minimal production scene: F, =, ma + Arrow, ma animated. */
const productionDocument = () => ({
  timeline: { fps: 30, durationFrames: 90 },
  components: [
    inst({ id: 'f', props: { text: 'F' }, position: { x: 100, y: 100 } }),
    inst({ id: 'eq', props: { text: '=' }, position: { x: 300, y: 100 } }),
    inst({
      id: 'ma',
      props: { text: 'ma' },
      position: { x: 300, y: 100 },
      timing: { startFrame: 0, durationFrames: 90 },
      animation: {
        tracks: [track('position.x', [{ frame: 0, value: 300 }, { frame: 30, value: 500 }])],
      },
    }),
    inst({
      id: 'arrow',
      componentDefinitionId: ARROW_DEF,
      props: { from: 'f', to: 'ma' },
    }),
  ],
  groups: [],
});

const lineAttrs = (html: string) => {
  const line = html.match(/<line[^>]*>/)?.[0] ?? '';
  const attr = (name: string) => line.match(new RegExp(`${name}="([^"]+)"`))?.[1];
  return { x1: attr('x1'), y1: attr('y1'), x2: attr('x2'), y2: attr('y2') };
};

describe('production composition metadata', () => {
  it('resolves fps/duration from document.timeline (single interpretation)', () => {
    expect(resolveTimeline({ timeline: { fps: 60, durationFrames: 600 } })).toEqual({
      fps: 60,
      durationFrames: 600,
    });
    expect(resolveTimeline(productionDocument())).toEqual({ fps: 30, durationFrames: 90 });
  });

  it('falls back to schema defaults for invalid timelines, never hard-coded output', () => {
    expect(resolveTimeline({ timeline: { fps: -1, durationFrames: 0 } as never })).toEqual({
      fps: 30,
      durationFrames: 300,
    });
  });
});

describe('production rendering semantics', () => {
  it('matches preview markup for the same document and frame (parity)', () => {
    const document = productionDocument();
    // Mocked useCurrentFrame() === 30, so production renders frame 30.
    expect(productionMarkup(document)).toBe(previewMarkup(document, 30));
  });

  it('renders animated values at the production frame', () => {
    const html = productionMarkup(productionDocument());
    // ma: 300 → 500 over frames 0..30; mocked frame is 30.
    expect(html).toContain('left:500px');
    expect(html).toContain('>ma<');
  });

  it('renders static position/size/transform/opacity/visibility identically to preview', () => {
    const document = {
      components: [
        inst({
          id: 's',
          position: { x: 100, y: 200 },
          size: { width: 400, height: 200 },
          transform: { rotation: 30, scaleX: 2, scaleY: 0.5 },
          style: { opacity: 0.5 },
          zIndex: 7,
        }),
        inst({ id: 'hidden', visible: false }),
        inst({ id: 'ghost', style: { opacity: 0 } }),
      ],
      groups: [],
    };
    const html = productionMarkup(document);
    expect(html).toBe(previewMarkup(document, 30));
    expect(html).toContain('left:100px');
    expect(html).toContain('transform:rotate(30deg) scale(2, 0.5)');
    expect(html).not.toContain('data-instance-id="hidden"');
    expect(html).toContain('data-instance-id="ghost"');
  });

  it('follows component timing in production output', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 90 },
      components: [inst({ id: 'a', timing: { startFrame: 30, durationFrames: 60 } })],
      groups: [],
    };
    expect(previewMarkup(document, 29)).not.toContain('data-instance-id="a"');
    expect(previewMarkup(document, 30)).toContain('data-instance-id="a"');
    expect(previewMarkup(document, 89)).toContain('data-instance-id="a"');
    expect(previewMarkup(document, 90)).not.toContain('data-instance-id="a"');
  });

  it('renders nested groups with deterministic z-order from the shared tree', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 90 },
      components: [
        inst({ id: 'f', groupId: 'gb', zIndex: 2 }),
        inst({ id: 'eq', groupId: 'gb', zIndex: 1 }),
        inst({ id: 'ma', groupId: 'ga', zIndex: 0 }),
        inst({ id: 'top', zIndex: 9 }),
      ],
      groups: [
        { id: 'ga', parentGroupId: null, zIndex: 0 },
        { id: 'gb', parentGroupId: 'ga', zIndex: 0 },
      ],
    };
    const html = productionMarkup(document);
    expect(html).toContain('data-group-id="ga"');
    expect(html).toContain('data-group-id="gb"');
    const evaluated = evaluateSceneAtFrame(document, 30);
    const paintOrder = flattenRenderTree(buildRenderTree(evaluated)).map((n) => n.instance.id);
    const positions = paintOrder.map((id) => html.indexOf(`data-instance-id="${id}"`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('moves production connectors when the referenced component animates', () => {
    const at0 = previewMarkup(productionDocument(), 0);
    const at30 = previewMarkup(productionDocument(), 30);
    // ma moves 300 → 500; the Arrow endpoint follows.
    expect(lineAttrs(at0).x2).toBe('300');
    expect(lineAttrs(at30).x2).toBe('500');
    // Connector math comes from the shared implementation on evaluated output.
    const evaluated = evaluateSceneAtFrame(productionDocument(), 30);
    const arrow = evaluated.components.find((c) => c.id === 'arrow')!;
    expect(connectorEndpointsFor(evaluated.components, arrow)?.p2.x).toBe(500);
  });

  it('renders Stage 3D keyframes (easing, multi-track) without conversion', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 90 },
      components: [
        inst({
          id: 'ma',
          timing: { startFrame: 0, durationFrames: 90 },
          animation: {
            tracks: [
              track('position.x', [
                { frame: 0, value: 100, easing: 'easeOut' },
                { frame: 60, value: 500, easing: 'easeInOut' },
              ]),
              track('style.opacity', [
                { frame: 0, value: 0 },
                { frame: 60, value: 1 },
              ]),
            ],
          },
        }),
      ],
      groups: [],
    };
    const html = previewMarkup(document, 30);
    // easeOut at t=0.5 → 0.75 → 100 + 400*0.75 = 400; opacity linear → 0.5.
    expect(html).toContain('left:400px');
    expect(html).toContain('opacity:0.5');
    expect(html).toBe(productionMarkup(document));
  });

  it('falls back deterministically for unknown components', () => {
    const html = productionMarkup(
      {
        components: [inst({ id: 'weird' })],
        groups: [],
      },
      { [LABEL_DEF]: 'concept-node' },
    );
    expect(html).toContain('Unsupported component');
    expect(html).toContain('concept-node');
  });

  it('never mutates the source document during production evaluation', () => {
    const document = productionDocument();
    const before = JSON.stringify(document);
    previewMarkup(document, 0);
    previewMarkup(document, 30);
    productionMarkup(document);
    evaluateSceneAtFrame(document, 45);
    expect(JSON.stringify(document)).toBe(before);
    const evaluated = evaluateSceneAtFrame(document, 15);
    expect(evaluated.components.find((c) => c.id === 'ma')?.position.x).toBe(400);
    // Stored base value untouched.
    expect(document.components.find((c) => c.id === 'ma')?.position.x).toBe(300);
  });
});
