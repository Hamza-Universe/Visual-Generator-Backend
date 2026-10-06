import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { assets, components, projects, renders } from '@app/db';
import type { Database } from '@app/db';
import {
  VideoSpecSchema,
  validateSpec,
  type RegistryComponent,
} from '@app/schema';
import { AppError, sendError } from '../errors.js';
import { createRenderQueue } from '../services/queue.js';
import { LocalStorage } from '@app/storage';

export const registerRenderRoutes = (
  app: FastifyInstance,
  db: Database,
  redisUrl: string,
  storage: LocalStorage,
) => {
  const queue = createRenderQueue(redisUrl);

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
      await queue.add('render', { renderId: render.id });
      return reply.code(202).send(render);
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
