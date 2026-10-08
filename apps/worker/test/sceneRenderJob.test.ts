import { describe, expect, it, vi } from 'vitest';
import {
  assertSnapshotDefinitionsResolved,
  collectSceneDocumentAssetIds,
  resolveSceneRenderAssets,
} from '../src/sceneRenderJob.js';
import { isSceneDocumentSnapshot, parseSceneRenderSnapshot } from '@app/schema';

vi.mock('remotion', () => ({}));

const LABEL_DEF = '00000000-0000-4000-8000-000000000001';
const LOGO_DEF = '00000000-0000-4000-8000-000000000003';

const inst = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sceneId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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

const snapshotOf = (components: unknown[], definitions: Record<string, string>) => ({
  source: 'scene-document' as const,
  document: {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    name: 'Scene',
    timeline: { fps: 30, durationFrames: 300 },
    components,
    groups: [],
  },
  definitions,
});

describe('render path decision', () => {
  it('routes explicit scene snapshots to the new path', () => {
    const snapshot = snapshotOf([], {});
    expect(isSceneDocumentSnapshot(snapshot)).toBe(true);
    expect(parseSceneRenderSnapshot(snapshot).document.name).toBe('Scene');
  });

  it('routes VideoSpec-shaped payloads to the legacy path', () => {
    expect(
      isSceneDocumentSnapshot({ version: 1, meta: {}, theme: {}, scenes: [] }),
    ).toBe(false);
  });
});

describe('snapshot definition resolution', () => {
  it('accepts fully resolved snapshots', () => {
    const snapshot = parseSceneRenderSnapshot(
      snapshotOf([inst({ componentDefinitionId: LABEL_DEF })], { [LABEL_DEF]: 'Label' }),
    );
    expect(() => assertSnapshotDefinitionsResolved(snapshot)).not.toThrow();
  });

  it('fails clearly when an instance definition is missing', () => {
    const snapshot = parseSceneRenderSnapshot(snapshotOf([inst()], {}));
    expect(() => assertSnapshotDefinitionsResolved(snapshot)).toThrow(/missing a definition/);
  });
});

describe('scene asset collection', () => {
  const registry = new Map([
    [LABEL_DEF, { assetProps: [] as string[] }],
    [LOGO_DEF, { assetProps: ['logoAssetId'] }],
  ]);

  it('collects asset ids from declared asset props only', () => {
    const document = {
      components: [
        inst({ id: 'a', componentDefinitionId: LOGO_DEF, props: { logoAssetId: 'asset-1' } }),
        inst({ id: 'b', props: { text: 'F' } }),
        inst({ id: 'c', componentDefinitionId: LOGO_DEF, props: { logoAssetId: '' } }),
      ],
    } as never;
    expect(collectSceneDocumentAssetIds(document, registry)).toEqual(new Set(['asset-1']));
  });

  it('throws on unknown definitions instead of corrupting the render', () => {
    const document = {
      components: [inst({ componentDefinitionId: 'missing-def' })],
    } as never;
    expect(() => collectSceneDocumentAssetIds(document, registry)).toThrow(
      /No registry component/,
    );
  });

  it('throws on non-string asset props', () => {
    const document = {
      components: [
        inst({ componentDefinitionId: LOGO_DEF, props: { logoAssetId: 42 } }),
      ],
    } as never;
    expect(() => collectSceneDocumentAssetIds(document, registry)).toThrow(/invalid/);
  });
});

describe('scene asset resolution', () => {
  const rows = [
    { id: 'asset-1', kind: 'logo', mimeType: 'image/png', storageKey: 'a/1.png' },
  ];

  it('maps owned rows to staged render inputs', () => {
    expect(
      resolveSceneRenderAssets(new Set(['asset-1']), rows, (key) => `/store/${key}`),
    ).toEqual([
      {
        id: 'asset-1',
        kind: 'logo',
        mimeType: 'image/png',
        sourcePath: '/store/a/1.png',
        fileName: 'a/1.png',
      },
    ]);
  });

  it('throws when a referenced asset is missing', () => {
    expect(() => resolveSceneRenderAssets(new Set(['gone']), rows, (k) => k)).toThrow(
      /missing or not owned/,
    );
  });

  it('resolves empty asset sets to empty inputs', () => {
    expect(resolveSceneRenderAssets(new Set(), rows, (k) => k)).toEqual([]);
  });
});
