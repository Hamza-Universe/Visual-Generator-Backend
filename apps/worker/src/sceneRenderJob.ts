import type { SceneRenderSnapshot } from '@app/schema';
import type { RenderInputAsset } from './renderer.js';

/**
 * SceneDocument render-job logic (Stage 3E).
 *
 * Pure, database-free helpers so the production job path is unit-testable.
 * The worker (`index.ts`) does the DB reads once, then these functions turn
 * the immutable snapshot into a deterministic `renderSceneDocument()` input.
 * Nothing here runs per frame — Remotion receives one coherent document.
 */

export type DefinitionRegistry = Map<string, { assetProps: string[] }>;

/**
 * Cancellation signal for cooperative worker shutdown (Stage 3F).
 *
 * Remotion's running encode cannot always be force-terminated, so
 * cancellation is persistent-first: the record is marked `cancelled`, the
 * worker observes it at lifecycle checkpoints and aborts via this error,
 * and the failure mapper keeps the record `cancelled` (never `failed`,
 * never `done`).
 */
export class RenderCancelledError extends Error {
  constructor() {
    super('Render was cancelled');
    this.name = 'RenderCancelledError';
  }
}

/**
 * Every instance's definition must be resolved in the snapshot map (built
 * once at enqueue time). Fails the job with a clear error instead of
 * rendering unknown components as gaps.
 */
export const assertSnapshotDefinitionsResolved = (
  snapshot: SceneRenderSnapshot,
): void => {
  for (const instance of snapshot.document.components) {
    const definitionId = (instance as { componentDefinitionId?: unknown })
      .componentDefinitionId;
    if (typeof definitionId !== 'string' || !snapshot.definitions[definitionId]) {
      throw new Error(
        `SceneDocument render snapshot is missing a definition for instance ${instance.id}`,
      );
    }
  }
};

/**
 * Asset ids referenced by a SceneDocument snapshot, following each
 * definition's declared `assetProps` (same convention as the legacy
 * VideoSpec path). Unknown definitions and non-string props throw with a
 * clear error instead of silently corrupting the render.
 */
export const collectSceneDocumentAssetIds = (
  document: SceneRenderSnapshot['document'],
  registry: DefinitionRegistry,
): Set<string> => {
  const ids = new Set<string>();
  for (const instance of document.components) {
    const definitionId = (instance as { componentDefinitionId?: unknown })
      .componentDefinitionId;
    if (typeof definitionId !== 'string') continue;
    const definition = registry.get(definitionId);
    if (!definition) {
      throw new Error(`No registry component found for ${definitionId}`);
    }
    for (const prop of definition.assetProps) {
      const value = (instance.props as Record<string, unknown>)[prop];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') {
        throw new Error(`Asset prop ${prop} on ${instance.id} is invalid`);
      }
      ids.add(value);
    }
  }
  return ids;
};

export interface SceneAssetRow {
  id: string;
  kind: string;
  mimeType: string;
  storageKey: string;
}

/**
 * Map referenced ids to staged render inputs. Every id must resolve to an
 * owned row (same ownership rule as the legacy path); otherwise throw.
 */
export const resolveSceneRenderAssets = (
  ids: Iterable<string>,
  assetRows: SceneAssetRow[],
  storagePath: (storageKey: string) => string,
): RenderInputAsset[] => {
  const byId = new Map(assetRows.map((asset) => [asset.id, asset]));
  const inputs: RenderInputAsset[] = [];
  for (const id of ids) {
    const asset = byId.get(id);
    if (!asset) {
      throw new Error(`Referenced asset ${id} is missing or not owned by the project user`);
    }
    inputs.push({
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sourcePath: storagePath(asset.storageKey),
      fileName: asset.storageKey,
    });
  }
  return inputs;
};
