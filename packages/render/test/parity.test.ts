import { describe, expect, it } from 'vitest';
import { renderSceneAtFrame } from '../src/index.js';
import type { TimelineDocument } from '../src/index.js';

/**
 * Deterministic preview/render parity.
 *
 * The editor preview (frontend ScenePreview) and the worker (scene.tsx) both
 * call `renderSceneAtFrame` from this package. These tests pin the properties
 * that make that sharing a parity guarantee:
 *   - identical input and frame always produce identical output (no hidden
 *     state, no time or randomness);
 *   - independently constructed equal documents produce identical output;
 *   - evaluating frames out of order does not change any frame's result;
 *   - the output is JSON-stable, so a serialised preview frame equals a
 *     serialised render frame byte-for-byte.
 */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const buildDocument = (): TimelineDocument & Record<string, unknown> =>
  ({
    id: ID(1),
    timeline: { fps: 30, durationFrames: 120 },
    groups: [],
    components: [
      {
        id: ID(10),
        groupId: null,
        props: {},
        position: { x: 100, y: 80 },
        size: { width: 300, height: 160 },
        transform: { rotation: 0, scaleX: 1, scaleY: 1 },
        style: { opacity: 1 },
        visible: true,
        zIndex: 1,
        timing: { start: 0, duration: 4 },
        animation: {
          enter: [],
          exit: [],
          keyframes: [],
          tracks: [
            {
              property: 'position.x',
              keyframes: [
                { frame: 0, value: 100, easing: 'easeOut' },
                { frame: 60, value: 600, easing: 'linear' },
              ],
            },
            {
              property: 'style.opacity',
              keyframes: [
                { frame: 0, value: 0, easing: 'linear' },
                { frame: 30, value: 1, easing: 'easeInOut' },
              ],
            },
          ],
        },
      },
      {
        id: ID(11),
        groupId: null,
        props: {},
        position: { x: 40, y: 300 },
        size: { width: 120, height: 120 },
        transform: { rotation: 15, scaleX: 1, scaleY: 1 },
        style: { opacity: 1 },
        visible: true,
        zIndex: 2,
        timing: { start: 1, duration: 3 },
        animation: {
          enter: [],
          exit: [],
          keyframes: [],
          tracks: [
            {
              property: 'transform.rotation',
              keyframes: [
                { frame: 30, value: 15, easing: 'linear' },
                { frame: 90, value: 45, easing: 'easeInBack' },
              ],
            },
          ],
        },
      },
    ],
  }) as unknown as TimelineDocument & Record<string, unknown>;

const FRAMES = [0, 1, 15, 30, 31, 59, 60, 89, 90, 119];

describe('editor/render parity: deterministic evaluation', () => {
  it('produces identical output for the same document and frame on repeated calls', () => {
    const doc = buildDocument();
    for (const frame of FRAMES) {
      const a = JSON.stringify(renderSceneAtFrame(doc, frame));
      const b = JSON.stringify(renderSceneAtFrame(doc, frame));
      expect(a).toBe(b);
    }
  });

  it('produces identical output for independently constructed equal documents', () => {
    for (const frame of FRAMES) {
      const preview = JSON.stringify(renderSceneAtFrame(buildDocument(), frame));
      const render = JSON.stringify(renderSceneAtFrame(buildDocument(), frame));
      expect(preview).toBe(render);
    }
  });

  it('is independent of evaluation order (no cross-frame state)', () => {
    const doc = buildDocument();
    const forward = FRAMES.map((f) => JSON.stringify(renderSceneAtFrame(doc, f)));
    const reversed = [...FRAMES].reverse().map((f) => JSON.stringify(renderSceneAtFrame(doc, f)));
    expect(reversed.reverse()).toEqual(forward);
  });

  it('does not mutate the input document', () => {
    const doc = buildDocument();
    const before = JSON.stringify(doc);
    for (const frame of FRAMES) renderSceneAtFrame(doc, frame);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('evaluates animated values at the expected frames', () => {
    const doc = buildDocument();
    const at = (frame: number) => {
      const { evaluatedScene } = renderSceneAtFrame(doc, frame);
      const item = (evaluatedScene.components as Array<{ id: string; position: { x: number } }>).find(
        (c) => c.id === ID(10),
      );
      return item?.position.x;
    };
    // Keyframe endpoints are exact, so editor and worker agree on them.
    expect(at(0)).toBe(100);
    expect(at(60)).toBe(600);
  });

  it('keeps visibility consistent with timing for every frame', () => {
    const doc = buildDocument();
    for (const frame of FRAMES) {
      const { evaluatedScene } = renderSceneAtFrame(doc, frame);
      const visible = (evaluatedScene.components as Array<{ id: string; visible: boolean }>).find(
        (c) => c.id === ID(11),
      )?.visible;
      // Element ID(11) runs from second 1 (frame 30) for 3 seconds (90 frames): frames 30..119.
      expect(visible).toBe(frame >= 30 && frame < 120);
    }
  });
});
