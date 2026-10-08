import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  evaluateSceneAtFrame,
  renderSceneAtFrame,
} from '@app/render';
import {
  SceneComposition,
  resolveSceneCompositionConfig,
  resolveSceneRenderer,
} from '../src/remotion/scene.js';
import type { SceneCompositionProps } from '../src/remotion/scene.js';
import { SceneFrameComposition } from '../src/remotion/sceneFrame.js';

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

const markup = (
  props: Partial<SceneCompositionProps> & { document: SceneCompositionProps['document'] },
) =>
  renderToStaticMarkup(
    createElement(SceneComposition, { definitions, ...props } as SceneCompositionProps),
  );

const track = (property: string, from: number, to: number, fromFrame = 0, toFrame = 30) => ({
  property,
  keyframes: [
    { frame: fromFrame, value: from },
    { frame: toFrame, value: to },
  ],
});

const lineAttrs = (html: string) => {
  const line = html.match(/<line[^>]*>/)?.[0] ?? '';
  const attr = (name: string) => line.match(new RegExp(`${name}="([^"]+)"`))?.[1];
  return { x1: attr('x1'), y1: attr('y1'), x2: attr('x2'), y2: attr('y2') };
};

describe('composition metadata from timeline', () => {
  it('derives fps and durationInFrames from document.timeline', () => {
    expect(
      resolveSceneCompositionConfig({
        timeline: { fps: 60, durationFrames: 600 },
        components: [],
        groups: [],
      }),
    ).toEqual({ fps: 60, durationInFrames: 600, width: 1600, height: 900 });
  });

  it('falls back to schema defaults without hard-coding them in the renderer', () => {
    expect(resolveSceneCompositionConfig({ components: [], groups: [] })).toEqual({
      fps: 30,
      durationInFrames: 300,
      width: 1600,
      height: 900,
    });
    expect(resolveSceneCompositionConfig(undefined)).toMatchObject({ fps: 30, durationInFrames: 300 });
  });

  it('does not hard-code 30fps/300f: distinct timelines produce distinct configs', () => {
    const a = resolveSceneCompositionConfig({
      timeline: { fps: 24, durationFrames: 240 },
      components: [],
      groups: [],
    });
    const b = resolveSceneCompositionConfig({
      timeline: { fps: 60, durationFrames: 600 },
      components: [],
      groups: [],
    });
    expect(a).not.toEqual(b);
  });
});

describe('frame evaluation in Remotion output', () => {
  it('renders static components identically across frames', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [inst({ id: 's', position: { x: 100, y: 50 } })],
      groups: [],
    };
    expect(markup({ document, frame: 0 })).toBe(markup({ document, frame: 150 }));
  });

  it('animates position.x across frames', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'm',
          position: { x: 100, y: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 100, 500)] },
        }),
      ],
      groups: [],
    };
    expect(markup({ document, frame: 0 })).toContain('left:100px');
    expect(markup({ document, frame: 30 })).toContain('left:500px');
    expect(markup({ document, frame: 15 })).toContain('left:300px');
  });

  it('animates opacity 0 → 1 and 1 → 0', () => {
    const fadeIn = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('style.opacity', 0, 1)] },
        }),
      ],
      groups: [],
    };
    expect(markup({ document: fadeIn, frame: 0 })).toContain('opacity:0');
    expect(markup({ document: fadeIn, frame: 30 })).toContain('opacity:1');
    const fadeOut = {
      ...fadeIn,
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('style.opacity', 1, 0)] },
        }),
      ],
    };
    expect(markup({ document: fadeOut, frame: 0 })).toContain('opacity:1');
    expect(markup({ document: fadeOut, frame: 30 })).toContain('opacity:0');
  });

  it('animates size, rotation, and scale', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'a',
          size: { width: 100, height: 100 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: {
            tracks: [
              track('size.width', 100, 400),
              track('size.height', 100, 200),
              track('transform.rotation', 0, 45),
              track('transform.scaleX', 1, 2),
              track('transform.scaleY', 1, 0.5),
            ],
          },
        }),
      ],
      groups: [],
    };
    const html = markup({ document, frame: 30 });
    expect(html).toContain('width:400px');
    expect(html).toContain('height:200px');
    expect(html).toContain('rotate(45deg) scale(2, 0.5)');
  });

  it('respects component timing: hidden before start and at end', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [inst({ id: 'a', timing: { startFrame: 30, durationFrames: 60 } })],
      groups: [],
    };
    expect(markup({ document, frame: 29 })).not.toContain('data-instance-id="a"');
    expect(markup({ document, frame: 30 })).toContain('data-instance-id="a"');
    expect(markup({ document, frame: 89 })).toContain('data-instance-id="a"');
    expect(markup({ document, frame: 90 })).not.toContain('data-instance-id="a"');
  });

  it('keeps visible=false hidden while opacity=0 still renders', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({ id: 'hidden', visible: false, timing: { startFrame: 0, durationFrames: 300 } }),
        inst({
          id: 'ghost',
          style: { opacity: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
        }),
      ],
      groups: [],
    };
    const html = markup({ document, frame: 10 });
    expect(html).not.toContain('data-instance-id="hidden"');
    expect(html).toContain('data-instance-id="ghost"');
  });

  it('animates multiple properties simultaneously', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: {
            tracks: [
              track('position.x', 0, 300),
              track('position.y', 0, 150),
              track('transform.rotation', 0, 45),
              track('style.opacity', 0, 0.8),
            ],
          },
        }),
      ],
      groups: [],
    };
    const html = markup({ document, frame: 30 });
    expect(html).toContain('left:300px');
    expect(html).toContain('top:150px');
    expect(html).toContain('rotate(45deg)');
    expect(html).toContain('opacity:0.8');
  });

  it('evaluates multiple instances independently', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'a',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 0, 100)] },
        }),
        inst({
          id: 'b',
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 0, 900)] },
        }),
      ],
      groups: [],
    };
    const html = markup({ document, frame: 30 });
    expect(html).toContain('left:100px');
    expect(html).toContain('left:900px');
  });

  it('animates children inside nested groups without flattening', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({ id: 'f', groupId: 'gb', props: { text: 'F' } }),
        inst({ id: 'eq', groupId: 'gb', props: { text: '=' } }),
        inst({
          id: 'ma',
          groupId: 'gb',
          props: { text: 'ma' },
          position: { x: 100, y: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 100, 500)] },
        }),
      ],
      groups: [
        { id: 'ga', parentGroupId: null, zIndex: 0 },
        { id: 'gb', parentGroupId: 'ga', zIndex: 0 },
      ],
    };
    const html = markup({ document, frame: 30 });
    expect(html).toContain('data-group-id="ga"');
    expect(html).toContain('data-group-id="gb"');
    expect(html).toContain('left:500px');
    expect(html).toContain('>ma<');
  });

  it('moves connectors when a referenced component animates', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({ id: 'f', position: { x: 100, y: 100 } }),
        inst({
          id: 'ma',
          position: { x: 300, y: 100 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 300, 700)] },
        }),
        inst({
          id: 'arrow',
          componentDefinitionId: ARROW_DEF,
          props: { from: 'f', to: 'ma' },
        }),
      ],
      groups: [],
    };
    const before = lineAttrs(markup({ document, frame: 0 }));
    const after = lineAttrs(markup({ document, frame: 30 }));
    expect(before).toEqual({ x1: '200', y1: '150', x2: '300', y2: '150' });
    expect(after).not.toEqual(before);
    expect(after.x2).toBe('700');
  });

  it('keeps z-order deterministic under animation', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({ id: 'back', zIndex: 1, timing: { startFrame: 0, durationFrames: 300 }, animation: { tracks: [track('position.x', 0, 500)] } }),
        inst({ id: 'front', zIndex: 9, timing: { startFrame: 0, durationFrames: 300 }, animation: { tracks: [track('position.x', 0, 500)] } }),
      ],
      groups: [],
    };
    const html = markup({ document, frame: 15 });
    expect(html.indexOf('data-instance-id="back"')).toBeLessThan(
      html.indexOf('data-instance-id="front"'),
    );
  });

  it('still fails gracefully for unknown components at any frame', () => {
    const html = markup({
      document: { components: [inst({ id: 'weird' })], groups: [] },
      definitions: { [LABEL_DEF]: 'concept-node' },
      frame: 42,
    });
    expect(html).toContain('Unsupported component');
    expect(resolveSceneRenderer('concept-node')).toBeNull();
  });

  it('is deterministic and never mutates the stored document', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'a',
          position: { x: 100, y: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 100, 500)] },
        }),
      ],
      groups: [],
    };
    const before = JSON.stringify(document);
    expect(markup({ document, frame: 15 })).toBe(markup({ document, frame: 15 }));
    expect(evaluateSceneAtFrame(document, 15)).toEqual(evaluateSceneAtFrame(document, 15));
    expect(JSON.stringify(document)).toBe(before);
  });

  it('shares one evaluation semantic via renderSceneAtFrame', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [inst({ id: 'a', timing: { startFrame: 0, durationFrames: 300 } })],
      groups: [],
    };
    const first = renderSceneAtFrame(document, 10);
    const second = renderSceneAtFrame(document, 10);
    expect(first).toEqual(second);
    expect(first.tree).toHaveLength(1);
  });
});

describe('Remotion frame smoke render', () => {
  it('renders F, =, ma with animated ma across several frames', () => {
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({ id: 'f', props: { text: 'F' } }),
        inst({ id: 'eq', props: { text: '=' } }),
        inst({
          id: 'ma',
          props: { text: 'ma' },
          position: { x: 100, y: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 100, 500)] },
        }),
      ],
      groups: [],
    };
    const frames = [0, 15, 30].map((frame) => markup({ document, frame }));
    for (const html of frames) {
      expect(html).toContain('>F<');
      expect(html).toContain('>ma<');
    }
    expect(frames[0]).toContain('left:100px');
    expect(frames[1]).toContain('left:300px');
    expect(frames[2]).toContain('left:500px');
  });

  it('reads the Remotion frame via useCurrentFrame (mocked frame 30)', () => {
    // `remotion` is mocked above: useCurrentFrame() === 30.
    const document = {
      timeline: { fps: 30, durationFrames: 300 },
      components: [
        inst({
          id: 'ma',
          props: { text: 'ma' },
          position: { x: 100, y: 0 },
          timing: { startFrame: 0, durationFrames: 300 },
          animation: { tracks: [track('position.x', 100, 500)] },
        }),
      ],
      groups: [],
    };
    const html = renderToStaticMarkup(
      createElement(SceneFrameComposition, { document, definitions }),
    );
    expect(html).toContain('left:500px');
    expect(html).toContain('>ma<');
  });
});
