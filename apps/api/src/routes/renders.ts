import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { assets, components, projects, renders } from '@app/db';
import type { Database } from '@app/db';
import {
  VideoSpecSchema,
  buildRenderTelemetryEvent,
  canTransitionRenderStatus,
  emitRenderTelemetry,
  findDuplicateSceneRender,
  normalizeClientKey,
  validateSpec,
  type RegistryComponent,
} from '@app/schema';
import { AppError, sendError } from '../errors.js';
import { createRenderQueue, type RenderQueueOptions } from '../services/queue.js';
import { toRenderStatusPayload } from '../services/renders.js';
import { getSceneDocument, requireSceneAccess } from '../services/documents.js';
import { LocalStorage } from '@app/storage';

export const registerRenderRoutes = (
  app: FastifyInstance,
  db: Database,
  redisUrl: string,
  storage: LocalStorage,
  jobOptions: RenderQueueOptions = {},
) => {
  const queue = createRenderQueue(redisUrl, jobOptions);

  app.post('/projects/:id/renders', async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      const userId = request.user!.id;
      const workers = await queue.getWorkers();
      if (!workers.length)
        throw new AppError(
          'RENDER_WORKER_UNAVAILABLE',
          'No render worker is connected. Start the worker process and try again.',
          503,
        );
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.userId, userId)));
      if (!project) throw new AppError('NOT_FOUND', 'Project not found', 404);
      const spec = VideoSpecSchema.parse(project.spec);
      const registryRows = await db.select().from(components);
      const registry = new Map(
        registryRows.map((row) => [
          row.name,
          row as unknown as RegistryComponent,
        ]),
      );
      const assetRows = await db
        .select({ id: assets.id, kind: assets.kind })
        .from(assets)
        .where(and(eq(assets.userId, userId), eq(assets.projectId, id)));
      const issues = validateSpec(spec, {
        registry,
        assetExists: (assetId) =>
          assetRows.some((asset) => asset.id === assetId),
        assetKind: (assetId) =>
          assetRows.find((asset) => asset.id === assetId)?.kind,
      });
      if (issues.length)
        throw new AppError(
          'INVALID_SPEC',
          'Spec violates semantic rules',
          422,
          issues,
        );
      const [render] = await db
        .insert(renders)
        .values({
          projectId: id,
          status: 'queued',
          progress: 0,
          specSnapshot: spec,
        })
        .returning();
      await queue.add('render', { renderId: render.id }, { jobId: render.id });
      // Stage 3G: legacy VideoSpec usage telemetry (event only — never the
      // spec payload) plus deprecation metadata. Existing clients unaffected.
      emitRenderTelemetry(
        (event) => request.log.info(event),
        buildRenderTelemetryEvent({
          event: 'requested',
          source: 'video-spec',
          renderId: render.id,
          projectId: id,
          sceneId: null,
        }),
      );
      void reply.header('Deprecation', 'true');
      void reply.header('Link', '</scenes/{id}/renders>; rel="successor-version"');
      return reply.code(202).send(render);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Stage 3E: enqueue a production SceneDocument render. The immutable
  // snapshot (timeline + components + groups + resolved definition map) is
  // stored explicitly as `{ source: 'scene-document', ... }` so the worker
  // routes it to the new path; legacy VideoSpec rows are untouched.
  //
  // Stage 3F: async lifecycle — persistent record (queued/progress 0),
  // optional client-provided idempotency key with a short duplicate guard,
  // BullMQ job keyed by render id (uniform with the legacy path).
  app.post('/scenes/:id/renders', async (request, reply) => {
    try {
      const sceneId = (request.params as { id: string }).id;
      const userId = request.user!.id;
      const workers = await queue.getWorkers();
      if (!workers.length)
        throw new AppError(
          'RENDER_WORKER_UNAVAILABLE',
          'No render worker is connected. Start the worker process and try again.',
          503,
        );
      const { scene } = await requireSceneAccess(db, sceneId, userId);
      const clientKey = normalizeClientKey(
        (request.body as { clientKey?: unknown } | undefined)?.clientKey,
      );
      if (clientKey) {
        const existing = await db
          .select()
          .from(renders)
          .where(and(eq(renders.sceneId, sceneId), eq(renders.projectId, scene.projectId)));
        const duplicate = findDuplicateSceneRender(existing, sceneId, clientKey);
        if (duplicate) return reply.code(202).send(duplicate);
      }
      const document = await getSceneDocument(db, sceneId, userId);
      const definitionIds = [
        ...new Set(
          document.components.map((c) => c.componentDefinitionId),
        ),
      ];
      const definitionRows =
        definitionIds.length > 0
          ? await db.select({ id: components.id, name: components.name }).from(components)
          : [];
      const definitions: Record<string, string> = {};
      for (const row of definitionRows) definitions[row.id] = row.name;
      for (const id of definitionIds) {
        if (!definitions[id])
          throw new AppError(
            'INVALID_DOCUMENT',
            `Scene references an unknown component definition (${id})`,
            422,
          );
      }
      const [render] = await db
        .insert(renders)
        .values({
          projectId: scene.projectId,
          sceneId,
          clientKey,
          status: 'queued',
          progress: 0,
          specSnapshot: { source: 'scene-document', document, definitions },
        })
        .returning();
      await queue.add('render', { renderId: render.id }, { jobId: render.id });
      // Stage 3G: render-source telemetry uses the same event shape as the
      // legacy path so usage is directly comparable (scene-document = current).
      emitRenderTelemetry(
        (event) => request.log.info(event),
        buildRenderTelemetryEvent({
          event: 'requested',
          source: 'scene-document',
          renderId: render.id,
          projectId: scene.projectId,
          sceneId,
        }),
      );
      return reply.code(202).send(render);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Stage 3F: cancel a queued/processing render. Best-effort for an
  // already-running Remotion process: the queued BullMQ job is removed when
  // possible, the record is marked cancelled, and the worker treats a
  // cancelled record as terminal (never renders it, never marks it done).
  app.post('/renders/:id/cancel', async (request, reply) => {
    try {
      const [row] = await db
        .select({ render: renders })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        .where(
          and(
            eq(renders.id, (request.params as { id: string }).id),
            eq(projects.userId, request.user!.id),
          ),
        );
      if (!row)
        return sendError(
          reply,
          new AppError('NOT_FOUND', 'Render not found', 404),
        );
      if (row.render.status === 'cancelled') return reply.send(row.render);
      if (!canTransitionRenderStatus(row.render.status, 'cancelled'))
        return sendError(
          reply,
          new AppError(
            'RENDER_TERMINAL',
            `Render is already ${row.render.status} and cannot be cancelled`,
            409,
          ),
        );
      try {
        const job = await queue.getJob(row.render.id);
        if (job) {
          const state = await job.getState();
          if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
            await job.remove();
          }
        }
      } catch {
        // Removal is best-effort (an active job cannot be force-removed);
        // the persistent cancelled state is authoritative for the worker.
      }
      const [cancelled] = await db
        .update(renders)
        .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
        .where(eq(renders.id, row.render.id))
        .returning();
      return reply.send(cancelled);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Stage 3F: lean polling payload (no heavyweight specSnapshot/document).
  app.get('/renders/:id/status', async (request, reply) => {
    try {
      const [row] = await db
        .select({ render: renders })
        .from(renders)
        .innerJoin(projects, eq(renders.projectId, projects.id))
        .where(
          and(
            eq(renders.id, (request.params as { id: string }).id),
            eq(projects.userId, request.user!.id),
          ),
        );
      if (!row)
        return sendError(
          reply,
          new AppError('NOT_FOUND', 'Render not found', 404),
        );
      return reply.send(toRenderStatusPayload(row.render));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  // Stage 3F: minimal render history for one scene (latest first).
  app.get('/scenes/:id/renders', async (request, reply) => {
    try {
      const sceneId = (request.params as { id: string }).id;
      await requireSceneAccess(db, sceneId, request.user!.id);
      return reply.send({
        items: await db
          .select()
          .from(renders)
          .where(eq(renders.sceneId, sceneId))
          .orderBy(desc(renders.createdAt))
          .limit(20),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/renders/:id', async (request, reply) => {
    const [row] = await db
      .select({ render: renders })
      .from(renders)
      .innerJoin(projects, eq(renders.projectId, projects.id))
      .where(
        and(
          eq(renders.id, (request.params as { id: string }).id),
          eq(projects.userId, request.user!.id),
        ),
      );
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Render not found', 404),
      );
    return reply.send(row.render);
  });

  app.get('/projects/:id/renders', async (request, reply) => {
    const projectId = (request.params as { id: string }).id;
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, projectId), eq(projects.userId, request.user!.id)),
      );
    if (!project)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Project not found', 404),
      );
    return reply.send({
      items: await db
        .select()
        .from(renders)
        .where(eq(renders.projectId, project.id))
        .orderBy(desc(renders.createdAt)),
    });
  });

  app.get('/renders/:id/file', async (request, reply) => {
    const [row] = await db
      .select({ render: renders, asset: assets })
      .from(renders)
      .innerJoin(projects, eq(renders.projectId, projects.id))
      .leftJoin(assets, eq(renders.outputAssetId, assets.id))
      .where(
        and(
          eq(renders.id, (request.params as { id: string }).id),
          eq(projects.userId, request.user!.id),
        ),
      );
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Render not found', 404),
      );
    if (row.render.status !== 'done' || !row.asset)
      return sendError(
        reply,
        new AppError('NOT_READY', 'Render is not ready', 409),
      );
    return reply
      .type(row.asset.mimeType)
      .send(storage.stream(row.asset.storageKey));
  });
};
