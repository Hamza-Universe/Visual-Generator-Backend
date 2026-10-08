import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  SCENE_DOCUMENT_SNAPSHOT_SOURCE,
  SceneDocumentSchema,
  defaultSpec,
  isSceneDocumentSnapshot,
  parseSceneRenderSnapshot,
} from '../src/index.js';

const sceneId = () => randomUUID();
const defId = () => randomUUID();

const document = () =>
  SceneDocumentSchema.parse({
    id: sceneId(),
    projectId: sceneId(),
    name: 'Scene 1',
    timeline: { fps: 60, durationFrames: 600 },
    components: [
      {
        id: sceneId(),
        sceneId: sceneId(),
        componentDefinitionId: defId(),
        props: { text: 'F' },
        position: { x: 100, y: 100 },
      },
    ],
    groups: [],
  });

describe('scene render snapshot', () => {
  it('marks scene snapshots with an explicit source', () => {
    expect(SCENE_DOCUMENT_SNAPSHOT_SOURCE).toBe('scene-document');
    const doc = document();
    const snapshot = { source: 'scene-document' as const, document: doc, definitions: {} };
    expect(isSceneDocumentSnapshot(snapshot)).toBe(true);
    expect(parseSceneRenderSnapshot(snapshot).document.timeline).toEqual({
      fps: 60,
      durationFrames: 600,
    });
  });

  it('round-trips definitions alongside the document', () => {
    const id = defId();
    const snapshot = parseSceneRenderSnapshot({
      source: 'scene-document',
      document: { ...document(), components: [] },
      definitions: { [id]: 'Label' },
    });
    expect(snapshot.definitions).toEqual({ [id]: 'Label' });
  });

  it('applies timeline defaults to documents without timeline metadata', () => {
    const doc = SceneDocumentSchema.parse({
      id: sceneId(),
      projectId: sceneId(),
      name: 'Legacy',
    });
    const snapshot = parseSceneRenderSnapshot({
      source: 'scene-document',
      document: doc,
      definitions: {},
    });
    expect(snapshot.document.timeline).toEqual({ fps: 30, durationFrames: 300 });
  });

  it('rejects legacy VideoSpec snapshots and garbage', () => {
    expect(isSceneDocumentSnapshot(defaultSpec())).toBe(false);
    expect(isSceneDocumentSnapshot(null)).toBe(false);
    expect(isSceneDocumentSnapshot({ source: 'video-spec' })).toBe(false);
    expect(() => parseSceneRenderSnapshot(defaultSpec())).toThrow(/Invalid SceneDocument/);
    expect(() => parseSceneRenderSnapshot(null)).toThrow(/Invalid SceneDocument/);
    expect(() =>
      parseSceneRenderSnapshot({ source: 'scene-document', document: {}, definitions: {} }),
    ).toThrow(/Invalid SceneDocument/);
  });

  it('rejects malformed definitions maps', () => {
    expect(() =>
      parseSceneRenderSnapshot({
        source: 'scene-document',
        document: document(),
        definitions: { 'not-a-uuid': 'Label' },
      }),
    ).toThrow(/Invalid SceneDocument/);
  });

  it('detaches the parsed snapshot from the request input (immutable job input)', () => {
    const input = {
      source: 'scene-document' as const,
      document: document(),
      definitions: {},
    };
    const parsed = parseSceneRenderSnapshot(input);
    parsed.document.name = 'mutated';
    parsed.document.components.length = 0;
    expect(input.document.name).not.toBe('mutated');
    expect(input.document.components).toHaveLength(1);
  });
});
