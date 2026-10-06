import { and, eq, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { projects, components, assets, transcripts } from '@app/db';
import {
  VideoSpecSchema,
  defaultSpec,
  validateSpec,
  type RegistryComponent,
} from '@app/schema';
import type { Database } from '@app/db';
import { AppError, sendError } from '../errors.js';

const context = async (
  db: Database,
  maxComponents?: number | null,
  userId?: string,
  projectId?: string,
) => {
  const rows = await db.select().from(components);
  const registry = new Map(
    rows.map((row) => [row.name, row as unknown as RegistryComponent]),
  );
  const assetConditions = userId ? [eq(assets.userId, userId)] : [];
  if (projectId) assetConditions.push(eq(assets.projectId, projectId));
  const assetRows = assetConditions.length
    ? await db
        .select({ id: assets.id, kind: assets.kind })
        .from(assets)
        .where(and(...assetConditions))
    : await db.select({ id: assets.id, kind: assets.kind }).from(assets);
  return {
    registry,
    assetExists: (id: string) => assetRows.some((a) => a.id === id),
    assetKind: (id: string) => assetRows.find((a) => a.id === id)?.kind,
    maxComponents: maxComponents ?? undefined,
  };
};
const parseSpec = async (
  db: Database,
  input: unknown,
  maxComponents?: number | null,
  userId?: string,
  projectId?: string,
) => {
  const parsed = VideoSpecSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError('BAD_INPUT', 'Invalid spec', 400, parsed.error.issues);
  const issues = validateSpec(
    parsed.data,
    await context(db, maxComponents, userId, projectId),
  );
  if (issues.length)
    throw new AppError(
      'INVALID_SPEC',
      'Spec violates semantic rules',
      422,
      issues,
    );
  return parsed.data;
};
export const registerProjectRoutes = (app: FastifyInstance, db: Database) => {
  app.post('/projects', async (request, reply) => {
    try {
      const body = request.body as unknown;
      if (
        !body ||
        typeof body !== 'object' ||
        typeof (body as { name?: unknown }).name !== 'string'
      )
        throw new AppError('BAD_INPUT', 'name is required');
      const input = body as { name: string; spec?: unknown };
      const spec = await parseSpec(
        db,
        input.spec ?? defaultSpec(),
        undefined,
        request.user!.id,
      );
      const [row] = await db
        .insert(projects)
        .values({ name: input.name, spec, userId: request.user!.id })
        .returning();
      return reply.code(201).send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/projects', async (request, reply) =>
    reply.send({
      items: await db
        .select({
          id: projects.id,
          name: projects.name,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(eq(projects.userId, request.user!.id))
        .orderBy(desc(projects.createdAt)),
    }),
  );
  app.get('/projects/:id/generation-context', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const transcriptId = (request.query as { transcriptId?: string }).transcriptId;
    const [project] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)));
    if (!project) return sendError(reply, new AppError('NOT_FOUND', 'Project not found', 404));
    const [transcript] = transcriptId ? await db.select({ transcript: transcripts }).from(transcripts).innerJoin(assets, eq(transcripts.assetId, assets.id)).where(and(eq(transcripts.id, transcriptId), eq(assets.userId, request.user!.id), eq(assets.projectId, id))) : [];
    return reply.send({
      project: { id: project.id, name: project.name, spec: project.spec, maxComponents: project.maxComponents },
      components: await db.select().from(components).orderBy(desc(components.createdAt)),
      assets: await db.select({ id: assets.id, kind: assets.kind, originalName: assets.originalName, mimeType: assets.mimeType, sizeBytes: assets.sizeBytes, durationSeconds: assets.durationSeconds }).from(assets).where(and(eq(assets.userId, request.user!.id), eq(assets.projectId, id))),
      transcript: transcript?.transcript ?? null,
    });
  });
  app.get('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)));
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Project not found', 404),
      );
    return reply.send(row);
  });
  app.put('/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = request.body as { name?: unknown; spec?: unknown };
      const [existing] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)));
      if (!existing) throw new AppError('NOT_FOUND', 'Project not found', 404);
      const values: { name?: string; spec?: unknown; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (typeof input.name === 'string') values.name = input.name;
      if (input.spec !== undefined)
        values.spec = await parseSpec(
          db,
          input.spec,
          existing.maxComponents,
          request.user!.id,
          id,
        );
      const [row] = await db
        .update(projects)
        .set(values)
        .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
        .returning();
      return reply.send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.patch('/projects/:id/settings', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const input = request.body as { maxComponents?: unknown };
      if (
        input.maxComponents !== null &&
        input.maxComponents !== undefined &&
        (!Number.isInteger(input.maxComponents) ||
          (input.maxComponents as number) < 1 ||
          (input.maxComponents as number) > 300)
      )
        throw new AppError(
          'BAD_INPUT',
          'maxComponents must be an integer from 1 to 300',
        );
      const [row] = await db
        .update(projects)
        .set({
          maxComponents:
            input.maxComponents === null
              ? null
              : (input.maxComponents as number | undefined),
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Project not found', 404);
      return reply.send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.delete('/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await db
      .delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, request.user!.id)))
      .returning({ id: projects.id });
    if (!deleted.length)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Project not found', 404),
      );
    return reply.code(204).send();
  });
  app.post('/projects/:id/validate', async (request, reply) => {
    const input = request.body as { spec?: unknown };
    const [project] = await db
      .select({ maxComponents: projects.maxComponents })
      .from(projects)
      .where(
        and(
          eq(projects.id, (request.params as { id: string }).id),
          eq(projects.userId, request.user!.id),
        ),
      );
    if (!project)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Project not found', 404),
      );
    const parsed = VideoSpecSchema.safeParse(input?.spec);
    if (!parsed.success)
      return reply.send({ valid: false, issues: parsed.error.issues });
    const issues = validateSpec(
      parsed.data,
      await context(db, project.maxComponents, request.user!.id),
    );
    return reply.send({ valid: issues.length === 0, issues });
  });
};
