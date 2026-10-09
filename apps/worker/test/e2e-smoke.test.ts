import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@app/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import {
  users,
  renders,
  projects,
  components,
  scenes,
  componentInstances,
  groups,
  assets,
} from '@app/db/schema';
import { LocalStorage } from '@app/storage';
import { buildApp } from '../../api/src/index.js';
import { requireSceneAccess, getSceneDocument } from '../../api/src/services/documents.js';
import { createRenderQueue } from '../../api/src/services/queue.js';
import {
  collectSceneDocumentAssetIds,
  resolveSceneRenderAssets,
  assertSnapshotDefinitionsResolved,
} from '../src/sceneRenderJob.js';
import { renderSceneDocument } from '../src/renderer.js';
import { parseSceneRenderSnapshot, SceneDocumentSchema, buildRenderTempPaths, RENDER_TEMP_DIR_NAME } from '@app/schema';
import { resolveTimeline } from '@app/render';

// Test configuration
const config = loadConfig();
const testDb = createDb(config.DATABASE_URL);
const testStorage = new LocalStorage(config.STORAGE_DIR);
const testQueue = createRenderQueue(config.REDIS_URL, {
  attempts: 1,
  backoffMs: 100,
});

// Helper to create a test user (insert directly into DB with proper UUID)
async function createTestUser() {
  const email = `test-${randomUUID()}@example.com`;
  const [user] = await testDb
    .insert(users)
    .values({
      name: 'Test User',
      email,
      passwordHash: 'test-hash', // Not actually used for this test
    })
    .returning();
  return { user };
}

// Helper to create a project
async function createProject(userId: string) {
  const [project] = await testDb
    .insert(projects)
    .values({ name: `Test Project ${randomUUID()}`, spec: { version: 1, meta: {}, theme: {}, scenes: [] }, userId })
    .returning();
  return project;
}

// Helper to create a scene
async function createScene(projectId: string, userId: string) {
  const [scene] = await testDb
    .insert(scenes)
    .values({ projectId, name: `Test Scene ${randomUUID()}` })
    .returning();
  return scene;
}

// Helper to get built-in component IDs
async function getBuiltInComponentIds() {
  const rows = await testDb
    .select({ id: components.id, name: components.name })
    .from(components)
    .where(eq(components.isPublic, true));
  return new Map(rows.map((r) => [r.name, r.id]));
}

// Helper to add instances to a scene
async function addInstances(
  sceneId: string,
  userId: string,
  componentId: string,
  count: number,
  baseProps: Record<string, unknown> = {}
) {
  const instances = [];
  for (let i = 0; i < count; i++) {
    const [inst] = await testDb
      .insert(componentInstances)
      .values({
        sceneId,
        componentDefinitionId: componentId,
        props: { ...baseProps, index: i },
        position: { x: 100 + i * 200, y: 100 },
        size: { width: 200, height: 100 },
        transform: { rotation: 0, scaleX: 1, scaleY: 1 },
        style: { opacity: 1 },
        visible: true,
        zIndex: i,
        timing: { start: 0, duration: 10 },
        animation: { enter: [], exit: [], keyframes: [], tracks: [] },
      })
      .returning();
    instances.push(inst);
  }
  return instances;
}

// Helper to apply fadeIn animation to instances
async function applyFadeInAnimation(
  instanceIds: string[],
  durationFrames: number
) {
  for (let i = 0; i < instanceIds.length; i++) {
    const instanceId = instanceIds[i];
    const staggerFrames = i * 10; // 1/3 second stagger
    const startFrame = staggerFrames;
    const endFrame = startFrame + Math.min(30, durationFrames / 3);

    await testDb
      .update(componentInstances)
      .set({
        animation: {
          enter: [],
          exit: [],
          keyframes: [],
          tracks: [
            {
              property: 'style.opacity',
              keyframes: [
                { frame: startFrame, value: 0, easing: 'linear' },
                { frame: endFrame, value: 1, easing: 'easeOut' },
              ],
            },
          ],
        },
      })
      .where(eq(componentInstances.id, instanceId));
  }
}

describe('P1: Complete scene-to-MP4 smoke test', () => {
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let project: Awaited<ReturnType<typeof createProject>>;
  let scene: Awaited<ReturnType<typeof createScene>>;
  let componentIds: Map<string, string>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    // Build Fastify app
    app = await buildApp(config);
    await app.ready();

    // Create test user
    user = await createTestUser();

    // Create project
    project = await createProject(user.user.id);

    // Create scene
    scene = await createScene(project.id, user.user.id);

    // Get built-in component IDs
    componentIds = await getBuiltInComponentIds();

    // Ensure we have at least 3 components
    expect(componentIds.size).toBeGreaterThanOrEqual(3);

    // Add 3+ components to scene: Label, Hub, CounterPill
    const labelId = componentIds.get('Label');
    const hubId = componentIds.get('Hub');
    const counterId = componentIds.get('CounterPill');

    expect(labelId).toBeDefined();
    expect(hubId).toBeDefined();
    expect(counterId).toBeDefined();

    const labels = await addInstances(scene.id, user.user.id, labelId!, 1, { text: 'Title' });
    const hubs = await addInstances(scene.id, user.user.id, hubId!, 1, { label: 'Center' });
    const counters = await addInstances(scene.id, user.user.id, counterId!, 1, { from: 0, to: 100 });

    // Apply fadeIn animation to all instances
    const allInstanceIds = [...labels, ...hubs, ...counters].map((i) => i.id);
    await applyFadeInAnimation(allInstanceIds, 300);

    // Create a group with some instances
    const [group] = await testDb
      .insert(groups)
      .values({ sceneId: scene.id, name: 'Test Group', zIndex: 10 })
      .returning();

    // Move hub into group
    await testDb
      .update(componentInstances)
      .set({ groupId: group.id })
      .where(eq(componentInstances.id, hubs[0].id));
  }, 30000);

  afterAll(async () => {
    await app.close();
    await testQueue.close();
    // Cleanup test data
    await testDb.delete(componentInstances).where(eq(componentInstances.sceneId, scene.id));
    await testDb.delete(groups).where(eq(groups.sceneId, scene.id));
    await testDb.delete(scenes).where(eq(scenes.id, scene.id));
    await testDb.delete(projects).where(eq(projects.id, project.id));
  }, 10000);

  it('renders a multi-component scene with animation to MP4 via direct renderSceneDocument', async () => {
    // Verify scene document structure
    const document = await getSceneDocument(testDb, scene.id, user.user.id);
    expect(document.components.length).toBeGreaterThanOrEqual(3);
    expect(document.groups.length).toBe(1);

    // Verify animations are present
    for (const instance of document.components) {
      expect(instance.animation.tracks).toBeDefined();
      if (instance.animation.tracks?.length) {
        const opacityTrack = instance.animation.tracks.find((t) => t.property === 'style.opacity');
        expect(opacityTrack).toBeDefined();
        expect(opacityTrack!.keyframes.length).toBeGreaterThan(0);
      }
    }

    // Enqueue render job (insert render row with scene-document snapshot)
    const definitionIds = [
      ...new Set(document.components.map((c) => c.componentDefinitionId)),
    ];
    const definitionRows = await testDb
      .select({ id: components.id, name: components.name })
      .from(components);
    const definitions: Record<string, string> = {};
    for (const row of definitionRows) definitions[row.id] = row.name;

    const [render] = await testDb
      .insert(renders)
      .values({
        projectId: scene.projectId,
        sceneId: scene.id,
        clientKey: `smoke-test-${randomUUID()}`,
        status: 'queued',
        progress: 0,
        specSnapshot: { source: 'scene-document', document, definitions },
      })
      .returning();

    // Update status to running
    await testDb
      .update(renders)
      .set({ status: 'running', progress: 0, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(renders.id, render.id));

    // Prepare temp output path
    const { outputPath: tempPath } = buildRenderTempPaths(
      config.STORAGE_DIR,
      randomUUID(),
    );
    await mkdir(join(config.STORAGE_DIR, RENDER_TEMP_DIR_NAME), { recursive: true });

    try {
      // Parse snapshot
      const snapshot = parseSceneRenderSnapshot(render.specSnapshot);
      assertSnapshotDefinitionsResolved(snapshot);

      // Get registry for asset collection
      const registryRows = await testDb
        .select({ id: components.id, assetProps: components.assetProps })
        .from(components);
      const registry = new Map(registryRows.map((row) => [row.id, row]));

      // Collect asset IDs
      const assetIds = collectSceneDocumentAssetIds(snapshot.document, registry);

      // Resolve assets
      const assetRows = await testDb
        .select()
        .from(assets)
        .where(and(eq(assets.userId, user.user.id), eq(assets.projectId, project.id)));
      const renderAssets = resolveSceneRenderAssets(assetIds, assetRows, (key) =>
        testStorage.path(key),
      );

      // Update progress
      await testDb
        .update(renders)
        .set({ progress: 5, updatedAt: new Date() })
        .where(eq(renders.id, render.id));

      // Render the scene document directly (bypassing queue/worker)
      await renderSceneDocument({
        document: snapshot.document,
        definitions: snapshot.definitions,
        assets: renderAssets,
        outputPath: tempPath,
        timeoutMs: config.RENDER_TIMEOUT_MS,
        onProgress: async (progress: number) => {
          const mapped = Math.min(100, Math.round(progress * 0.95) + 5);
          await testDb
            .update(renders)
            .set({ progress: mapped, updatedAt: new Date() })
            .where(eq(renders.id, render.id));
        },
      });

      // Store render output
      const outputStat = await stat(tempPath);
      const key = await testStorage.save({
        sourcePath: tempPath,
        extension: '.mp4',
      });
      const [asset] = await testDb
        .insert(assets)
        .values({
          kind: 'video',
          originalName: `${render.id}.mp4`,
          storageKey: key,
          mimeType: 'video/mp4',
          sizeBytes: outputStat.size,
          userId: user.user.id,
          projectId: project.id,
        })
        .returning();

      await testDb
        .update(renders)
        .set({
          status: 'done',
          progress: 100,
          outputAssetId: asset.id,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(renders.id, render.id));

      // Verify render completed successfully
      const [finalRender] = await testDb.select().from(renders).where(eq(renders.id, render.id));
      expect(finalRender).toBeDefined();
      expect(finalRender!.status).toBe('done');
      expect(finalRender!.outputAssetId).toBeDefined();
      expect(finalRender!.completedAt).not.toBeNull();
      expect(finalRender!.progress).toBe(100);

      // Verify output asset exists
      const [outputAsset] = await testDb
        .select()
        .from(assets)
        .where(eq(assets.id, finalRender!.outputAssetId!));
      expect(outputAsset).toBeDefined();
      expect(outputAsset.mimeType).toBe('video/mp4');
      expect(outputAsset.sizeBytes).toBeGreaterThan(0);

      // Verify file exists and has content
      const filePath = testStorage.path(outputAsset.storageKey);
      const fileStat = await stat(filePath);
      expect(fileStat.size).toBeGreaterThan(0);
      expect(fileStat.size).toBe(outputAsset.sizeBytes);

      // Verify render metadata
      expect(finalRender!.startedAt).not.toBeNull();
    } finally {
      // Cleanup temp file
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }, 180000);
});