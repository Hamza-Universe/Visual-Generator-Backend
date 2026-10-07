import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { scenes } from '@app/db';
import type { Database } from '@app/db';
import {
  CreateGroupInputSchema,
  CreateInstanceInputSchema,
  CreateSceneInputSchema,
  UpdateGroupInputSchema,
  UpdateInstanceInputSchema,
  UpdateSceneInputSchema,
} from '@app/schema';
import { AppError, sendError } from '../errors.js';
import {
  addInstanceToGroup,
  createGroup,
  createInstance,
  createScene,
  deleteGroup,
  deleteInstance,
  getInstance,
  getSceneDocument,
  listProjectScenes,
  listSceneGroups,
  listSceneInstances,
  removeInstanceFromGroup,
  requireSceneAccess,
  updateGroup,
  updateInstance,
} from '../services/documents.js';

export const registerSceneRoutes = (app: FastifyInstance, db: Database) => {
  app.get('/projects/:id/scenes', async (request, reply) => {
    try {
      return reply.send({
        items: await listProjectScenes(
          db,
          (request.params as { id: string }).id,
          request.user!.id,
        ),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/projects/:id/scenes', async (request, reply) => {
    try {
      const parsed = CreateSceneInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid scene payload', 400, parsed.error.issues);
      const row = await createScene(
        db,
        (request.params as { id: string }).id,
        request.user!.id,
        parsed.data,
      );
      return reply.code(201).send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/scenes/:id', async (request, reply) => {
    try {
      const { scene } = await requireSceneAccess(
        db,
        (request.params as { id: string }).id,
        request.user!.id,
      );
      return reply.send(scene);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/scenes/:id', async (request, reply) => {
    try {
      const parsed = UpdateSceneInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid scene payload', 400, parsed.error.issues);
      const { scene } = await requireSceneAccess(
        db,
        (request.params as { id: string }).id,
        request.user!.id,
      );
      const [row] = await db
        .update(scenes)
        .set(parsed.data)
        .where(eq(scenes.id, scene.id))
        .returning();
      return reply.send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/scenes/:id', async (request, reply) => {
    try {
      await requireSceneAccess(db, (request.params as { id: string }).id, request.user!.id);
      await db.delete(scenes).where(eq(scenes.id, (request.params as { id: string }).id));
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/scenes/:id/document', async (request, reply) => {
    try {
      return reply.send(
        await getSceneDocument(db, (request.params as { id: string }).id, request.user!.id),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/scenes/:id/instances', async (request, reply) => {
    try {
      return reply.send({
        items: await listSceneInstances(
          db,
          (request.params as { id: string }).id,
          request.user!.id,
        ),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/scenes/:id/instances', async (request, reply) => {
    try {
      const parsed = CreateInstanceInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid instance payload', 400, parsed.error.issues);
      const row = await createInstance(
        db,
        (request.params as { id: string }).id,
        request.user!.id,
        parsed.data,
      );
      return reply.code(201).send(row);
    } catch (error) {
      const withCode = error as { code?: string; details?: unknown[] };
      if (withCode?.code === 'INVALID_PROPS')
        return sendError(
          reply,
          new AppError('INVALID_PROPS', 'Component props are invalid', 400, (withCode.details as never[]) ?? []),
        );
      if (withCode?.code === 'BAD_REFERENCE')
        return sendError(
          reply,
          new AppError('BAD_REFERENCE', 'Component reference must be a component in the same scene', 400),
        );
      return sendError(reply, error);
    }
  });

  app.get('/instances/:id', async (request, reply) => {
    try {
      return reply.send(
        await getInstance(db, (request.params as { id: string }).id, request.user!.id),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/instances/:id', async (request, reply) => {
    try {
      const parsed = UpdateInstanceInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid instance payload', 400, parsed.error.issues);
      return reply.send(
        await updateInstance(db, (request.params as { id: string }).id, request.user!.id, parsed.data),
      );
    } catch (error) {
      const withCode = error as { code?: string; details?: unknown[] };
      if (withCode?.code === 'INVALID_PROPS')
        return sendError(
          reply,
          new AppError('INVALID_PROPS', 'Component props are invalid', 400, (withCode.details as never[]) ?? []),
        );
      if (withCode?.code === 'BAD_REFERENCE')
        return sendError(
          reply,
          new AppError('BAD_REFERENCE', 'Component reference must be a component in the same scene', 400),
        );
      return sendError(reply, error);
    }
  });

  app.delete('/instances/:id', async (request, reply) => {
    try {
      await deleteInstance(db, (request.params as { id: string }).id, request.user!.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/scenes/:id/groups', async (request, reply) => {
    try {
      return reply.send({
        items: await listSceneGroups(
          db,
          (request.params as { id: string }).id,
          request.user!.id,
        ),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/scenes/:id/groups', async (request, reply) => {
    try {
      const parsed = CreateGroupInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid group payload', 400, parsed.error.issues);
      const row = await createGroup(
        db,
        (request.params as { id: string }).id,
        request.user!.id,
        parsed.data,
      );
      return reply.code(201).send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/groups/:id', async (request, reply) => {
    try {
      const parsed = UpdateGroupInputSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid group payload', 400, parsed.error.issues);
      return reply.send(
        await updateGroup(db, (request.params as { id: string }).id, request.user!.id, parsed.data),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/groups/:id', async (request, reply) => {
    try {
      await deleteGroup(db, (request.params as { id: string }).id, request.user!.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/groups/:id/members/:instanceId', async (request, reply) => {
    try {
      const { id, instanceId } = request.params as { id: string; instanceId: string };
      return reply.send(await addInstanceToGroup(db, id, instanceId, request.user!.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/groups/:id/members/:instanceId', async (request, reply) => {
    try {
      const { instanceId } = request.params as { id: string; instanceId: string };
      return reply.send(await removeInstanceFromGroup(db, instanceId, request.user!.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
