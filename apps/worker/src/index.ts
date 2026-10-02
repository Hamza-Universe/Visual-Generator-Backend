import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { assets, components, createDb, projects, renders } from '@app/db';
import { eq } from 'drizzle-orm';
import { LocalStorage } from '@app/storage';
import { VideoSpecSchema, type Scene } from '@app/schema';
import { renderProject, type RenderInputAsset } from './renderer.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, rm } from 'node:fs/promises';
import { loadConfig } from './config.js';

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
    await db
      .update(renders)
      .set({ status: 'running', progress: 0, updatedAt: new Date() })
      .where(eq(renders.id, render.id));
    await mkdir(config.STORAGE_DIR, { recursive: true });
    const tempPath = join(config.STORAGE_DIR, `${randomUUID()}.mp4`);
    try {
      const spec = VideoSpecSchema.parse(render.specSnapshot);
      const registryRows = await db
        .select({ name: components.name, assetProps: components.assetProps })
        .from(components);
      const registry = new Map(registryRows.map((row) => [row.name, row]));
      const assetIds = referencedAssetIds(spec, spec.scenes, registry);
      const assetRows = await db
        .select()
        .from(assets)
        .where(eq(assets.userId, project.userId));
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
      let lastProgressAt = 0;
      await renderProject({
        spec,
        assets: renderAssets,
        outputPath: tempPath,
        onProgress: async (progress) => {
          const now = Date.now();
          if (progress === 100 || now - lastProgressAt >= 1000) {
            lastProgressAt = now;
            await db
              .update(renders)
              .set({ progress, updatedAt: new Date() })
              .where(eq(renders.id, render.id));
          }
        },
      });
      const outputStat = await stat(tempPath);
      const key = await storage.save({
        sourcePath: tempPath,
        extension: '.mp4',
      });
      const [asset] = await db
        .insert(assets)
        .values({
          kind: 'video',
          originalName: `${render.id}.mp4`,
          storageKey: key,
          mimeType: 'video/mp4',
          sizeBytes: outputStat.size,
          userId: project.userId,
        })
        .returning();
      await db
        .update(renders)
        .set({
          status: 'done',
          progress: 100,
          outputAssetId: asset.id,
          updatedAt: new Date(),
        })
        .where(eq(renders.id, render.id));
      return { renderId: render.id, status: 'done' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Render failed';
      await db
        .update(renders)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(eq(renders.id, render.id));
      throw error;
    } finally {
      await rm(tempPath, { force: true });
    }
  },
  { connection: { host: redis.hostname, port: Number(redis.port || 6379) } },
);

worker.on('failed', (job, error) =>
  console.error('Render failed', job?.id, error),
);
