import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { assets, components, createDb, projects, renders } from '@app/db';
import { and, eq } from 'drizzle-orm';
import { LocalStorage } from '@app/storage';
import {
  VideoSpecSchema,
  buildRenderTelemetryEvent,
  decideRenderFailure,
  emitRenderTelemetry,
  isSceneDocumentSnapshot,
  mapSceneRenderProgress,
  parseSceneRenderSnapshot,
  resolveRenderStart,
  type Scene,
} from '@app/schema';
import { renderProject, renderSceneDocument, type RenderInputAsset } from './renderer.js';
import {
  RenderCancelledError,
  assertSnapshotDefinitionsResolved,
  collectSceneDocumentAssetIds,
  resolveSceneRenderAssets,
} from './sceneRenderJob.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, rm } from 'node:fs/promises';
import { loadConfig } from './config.js';
import type { Database } from '@app/db';

loadDotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
});

const config = loadConfig();
const redis = new URL(config.REDIS_URL);
const db = createDb(config.DATABASE_URL);
const storage = new LocalStorage(config.STORAGE_DIR);

const referencedAssetIds = (
  spec: ReturnType<typeof VideoSpecSchema.parse>,
  scenes: Scene[],
  registry: Map<string, { assetProps: string[] }>,
): Set<string> => {
  const ids = new Set<string>();
  if (spec.audioAssetId) ids.add(spec.audioAssetId);
  if (spec.sideVideo) ids.add(spec.sideVideo.assetId);
  if (spec.theme.background.type === 'image')
    ids.add(spec.theme.background.assetId);
  for (const scene of scenes) {
    const component = registry.get(scene.component);
    if (!component)
      throw new Error(`No registry component found for ${scene.component}`);
    for (const prop of component.assetProps) {
      const value = scene.props[prop];
      if (typeof value !== 'string')
        throw new Error(`Asset prop ${prop} on ${scene.id} is invalid`);
      ids.add(value);
    }
  }
  return ids;
};

export const worker = new Worker<{ renderId: string }>(
  'render',
  async (job) => {
    const [render] = await db
      .select()
      .from(renders)
      .where(eq(renders.id, job.data.renderId));
    if (!render) throw new Error('Render not found');
    const [project] = await db
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, render.projectId));
    if (!project?.userId) throw new Error('Render project has no owner');
    // Stage 3F: a record cancelled while queued never starts rendering.
    const start = resolveRenderStart(render.status);
    if (start.terminal) return { renderId: render.id, status: 'cancelled' };
    await db
      .update(renders)
      .set({ status: 'running', progress: 0, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(renders.id, render.id));
    await mkdir(config.STORAGE_DIR, { recursive: true });
    const tempPath = join(config.STORAGE_DIR, `${randomUUID()}.mp4`);
    try {
      // Stage 3E migration boundary: rows whose specSnapshot is an explicit
      // scene-document envelope render through the new SceneDocument path;
      // everything else keeps the legacy VideoSpec path, unchanged.
      if (isSceneDocumentSnapshot(render.specSnapshot)) {
        await runSceneDocumentRender(db, storage, render.id, render.projectId, project.userId, tempPath);
      } else {
        await runLegacyRender(db, storage, render.id, render.projectId, project.userId, tempPath);
      }
      // Stage 3G: lifecycle telemetry with an explicit source so legacy vs
      // current usage is directly comparable. Payload-free by construction.
      emitRenderTelemetry(
        (event) => console.info(JSON.stringify(event)),
        buildRenderTelemetryEvent({
          event: 'succeeded',
          source: isSceneDocumentSnapshot(render.specSnapshot)
            ? 'scene-document'
            : 'video-spec',
          renderId: render.id,
          projectId: render.projectId,
          sceneId: isSceneDocumentSnapshot(render.specSnapshot)
            ? render.specSnapshot.document.id
            : null,
        }),
      );
      return { renderId: render.id, status: 'done' };
    } catch (error) {
      // Stage 3F: cancellation stays `cancelled` (never `failed`, never
      // `done`); everything else records a useful message. Records never
      // stick in `running`.
      const [current] = await db
        .select({ status: renders.status })
        .from(renders)
        .where(eq(renders.id, render.id));
      const decision = decideRenderFailure(
        error,
        current?.status,
        error instanceof RenderCancelledError,
      );
      // Cancellations are intentional, not failures — only failed outcomes
      // emit the failure event so legacy/current failure rates stay honest.
      if (decision.status === 'failed') {
        emitRenderTelemetry(
          (event) => console.info(JSON.stringify(event)),
          buildRenderTelemetryEvent({
            event: 'failed',
            source: isSceneDocumentSnapshot(render.specSnapshot)
              ? 'scene-document'
              : 'video-spec',
            renderId: render.id,
            projectId: render.projectId,
            sceneId: isSceneDocumentSnapshot(render.specSnapshot)
              ? render.specSnapshot.document.id
              : null,
          }),
        );
      }
      await db
        .update(renders)
        .set({
          status: decision.status,
          ...(decision.error === null ? {} : { error: decision.error }),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(renders.id, render.id));
      throw error;
    } finally {
      await rm(tempPath, { force: true });
    }
  },
  {
    connection: {
      host: redis.hostname,
      port: Number(redis.port || 6379),
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    },
  },
);

worker.on('failed', (job, error) =>
  console.error('Render failed', job?.id, error),
);

/** Throttled progress writer shared by both render paths (unchanged semantics). */
const trackProgress = (db: Database, renderId: string) => {
  let lastProgressAt = 0;
  return async (progress: number) => {
    const now = Date.now();
    if (progress === 100 || now - lastProgressAt >= 1000) {
      lastProgressAt = now;
      await db
        .update(renders)
        .set({ progress, updatedAt: new Date() })
        .where(eq(renders.id, renderId));
    }
  };
};

/**
 * Stage 3F progress writer for SceneDocument renders: maps Remotion encode
 * progress onto lifecycle milestones and cooperatively observes
 * cancellation about once per second (never per frame).
 */
const trackSceneProgress = (db: Database, renderId: string) => {
  let lastProgressAt = 0;
  return async (progress: number) => {
    const [row] = await db
      .select({ status: renders.status })
      .from(renders)
      .where(eq(renders.id, renderId));
    if (!row || row.status === 'cancelled') throw new RenderCancelledError();
    const mapped = mapSceneRenderProgress(progress);
    const now = Date.now();
    if (mapped === 100 || now - lastProgressAt >= 1000) {
      lastProgressAt = now;
      await db
        .update(renders)
        .set({ progress: mapped, updatedAt: new Date() })
        .where(eq(renders.id, renderId));
    }
  };
};

/** Store the finished mp4 and mark the render done (shared by both paths). */
const storeRenderOutput = async (
  db: Database,
  storage: LocalStorage,
  renderId: string,
  projectId: string,
  userId: string,
  tempPath: string,
) => {
  // Stage 3F: a render cancelled mid-flight must never flip to done.
  const [row] = await db
    .select({ status: renders.status })
    .from(renders)
    .where(eq(renders.id, renderId));
  if (!row) throw new Error('Render not found');
  if (row.status === 'cancelled') throw new RenderCancelledError();
  const outputStat = await stat(tempPath);
  const key = await storage.save({
    sourcePath: tempPath,
    extension: '.mp4',
  });
  const [asset] = await db
    .insert(assets)
    .values({
      kind: 'video',
      originalName: `${renderId}.mp4`,
      storageKey: key,
      mimeType: 'video/mp4',
      sizeBytes: outputStat.size,
      userId,
      projectId,
    })
    .returning();
  await db
    .update(renders)
    .set({
      status: 'done',
      progress: 100,
      outputAssetId: asset.id,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(renders.id, renderId));
};

/** Legacy VideoSpec path — behavior preserved exactly. */
const runLegacyRender = async (
  db: Database,
  storage: LocalStorage,
  renderId: string,
  projectId: string,
  userId: string,
  tempPath: string,
) => {
  const [render] = await db.select().from(renders).where(eq(renders.id, renderId));
  if (!render) throw new Error('Render not found');
  const spec = VideoSpecSchema.parse(render.specSnapshot);
  const registryRows = await db
    .select({ name: components.name, assetProps: components.assetProps })
    .from(components);
  const registry = new Map(registryRows.map((row) => [row.name, row]));
  const assetIds = referencedAssetIds(spec, spec.scenes, registry);
  const assetRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.projectId, projectId)));
  const byId = new Map(assetRows.map((asset) => [asset.id, asset]));
  const renderAssets: RenderInputAsset[] = [];
  for (const id of assetIds) {
    const asset = byId.get(id);
    if (!asset)
      throw new Error(
        `Referenced asset ${id} is missing or not owned by the project user`,
      );
    if (
      spec.audioAssetId === id &&
      !['audio', 'video'].includes(asset.kind)
    )
      throw new Error('audioAssetId must reference audio or video');
    if (spec.sideVideo?.assetId === id && asset.kind !== 'side_video')
      throw new Error('sideVideo must reference a side_video asset');
    if (
      spec.theme.background.type === 'image' &&
      spec.theme.background.assetId === id &&
      !['image', 'logo'].includes(asset.kind)
    )
      throw new Error(
        'Image background must reference an image or logo asset',
      );
    renderAssets.push({
      id: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sourcePath: storage.path(asset.storageKey),
      fileName: asset.storageKey,
    });
  }
  await renderProject({
    spec,
    assets: renderAssets,
    outputPath: tempPath,
    onProgress: trackProgress(db, renderId),
  });
  await storeRenderOutput(db, storage, renderId, projectId, userId, tempPath);
};

/**
 * New SceneDocument path (Stage 3E).
 *
 * Operates on one immutable snapshot (timeline + components + groups plus a
 * resolved definition map). A single coherent document reaches the renderer —
 * no per-frame database queries, no editor-state reads, no mutation.
 */
const runSceneDocumentRender = async (
  db: Database,
  storage: LocalStorage,
  renderId: string,
  projectId: string,
  userId: string,
  tempPath: string,
) => {
  const [render] = await db.select().from(renders).where(eq(renders.id, renderId));
  if (!render) throw new Error('Render not found');
  const snapshot = parseSceneRenderSnapshot(render.specSnapshot);
  assertSnapshotDefinitionsResolved(snapshot);
  const registryRows = await db
    .select({
      id: components.id,
      assetProps: components.assetProps,
    })
    .from(components);
  const registry = new Map(registryRows.map((row) => [row.id, row]));
  const assetIds = collectSceneDocumentAssetIds(snapshot.document, registry);
  const assetRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.projectId, projectId)));
  const renderAssets = resolveSceneRenderAssets(assetIds, assetRows, (key) =>
    storage.path(key),
  );
  // Milestone: snapshot parsed + assets resolved (bundle prepared next).
  await db
    .update(renders)
    .set({ progress: 5, updatedAt: new Date() })
    .where(eq(renders.id, renderId));
  await renderSceneDocument({
    document: snapshot.document,
    definitions: snapshot.definitions,
    assets: renderAssets,
    outputPath: tempPath,
    onProgress: trackSceneProgress(db, renderId),
  });
  await storeRenderOutput(db, storage, renderId, projectId, userId, tempPath);
};
