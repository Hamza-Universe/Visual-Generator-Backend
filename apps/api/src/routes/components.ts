import { eq, desc, and, or, ilike, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { components, projects } from '@app/db';
import type { Database } from '@app/db';
import * as AjvNamespace from 'ajv';
import { AppError, sendError } from '../errors.js';

const check = (input: Record<string, unknown>) => {
  const Ajv = AjvNamespace.default as unknown as new (
    options?: Record<string, unknown>,
  ) => {
    validateSchema(schema: unknown): boolean;
    compile(
      schema: unknown,
    ): ((data: unknown) => boolean) & { errors?: unknown[] };
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = input.propsSchema;
  if (!schema || typeof schema !== 'object' || !ajv.validateSchema(schema))
    throw new AppError('INVALID_PROPS_SCHEMA', 'propsSchema does not compile');
  const validator = ajv.compile(schema);
  if (!validator(input.defaultProps ?? {}))
    throw new AppError(
      'INVALID_DEFAULT_PROPS',
      'defaultProps is invalid',
      400,
      validator.errors ?? [],
    );
  for (const key of ['colorProps', 'refProps', 'assetProps'])
    for (const name of (input[key] as string[]) ?? [])
      if (!(
        (schema as { properties?: Record<string, unknown> }).properties &&
        name in (schema as { properties: Record<string, unknown> }).properties
      ))
        throw new AppError('BAD_INPUT', `${name} is not a property`);
};

export const registerComponentRoutes = (app: FastifyInstance, db: Database) => {
  // GET /components - list with filters (query, filter: 'mine'|'public'|'project', projectId)
  app.get('/components', async (request, reply) => {
    const user = request.user as { id: string } | undefined;
    const query = String((request.query as { query?: string }).query ?? '').trim().toLowerCase();
    const filter = (request.query as { filter?: string }).filter ?? 'all'; // 'mine' | 'public' | 'project' | 'all'
    const projectId = (request.query as { projectId?: string }).projectId;

    let whereConditions: Array<ReturnType<typeof eq> | ReturnType<typeof isNull> | ReturnType<typeof or>> = [];

    if (filter === 'mine' && user) {
      whereConditions.push(eq(components.userId, user.id));
    } else if (filter === 'public') {
      whereConditions.push(eq(components.isPublic, 'true'));
    } else if (filter === 'project' && projectId && user) {
      // Get components used in this project
      const project = await db
        .select({ spec: projects.spec })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)));
      if (project.length === 0) {
        return reply.send({ items: [] });
      }
      const spec = project[0].spec as { scenes?: Array<{ component: string }> };
      const componentNames = new Set(spec.scenes?.map(s => s.component) ?? []);
      if (componentNames.size === 0) {
        return reply.send({ items: [] });
      }
      // We need to fetch components by name - use a different approach
      // For simplicity, fetch all user's components + public components and filter in memory
      whereConditions.push(or(
        eq(components.userId, user.id),
        eq(components.isPublic, 'true')
      ));
    } else {
      // 'all' - show user's private + public components
      if (user) {
        whereConditions.push(or(
          eq(components.userId, user.id),
          eq(components.isPublic, 'true')
        ));
      } else {
        whereConditions.push(eq(components.isPublic, 'true'));
      }
    }

    const baseQuery = db.select().from(components);
    const rows = whereConditions.length > 0
      ? await baseQuery.where(and(...whereConditions)).orderBy(desc(components.createdAt))
      : await baseQuery.orderBy(desc(components.createdAt));

    let filteredRows = rows;
    if (query) {
      filteredRows = rows.map((component) => {
        const name = `${component.name} ${component.displayName}`.toLowerCase();
        const description = component.description.toLowerCase();
        const exact = name === query ? 1000 : 0;
        const namePrefix = name.startsWith(query) ? 700 : 0;
        const nameToken = name.split(/\s+/).some((token) => token.startsWith(query)) ? 500 : 0;
        const descriptionMatch = description.includes(query) ? 100 : 0;
        return { component, score: exact + namePrefix + nameToken + descriptionMatch, matchedField: exact || namePrefix || nameToken ? 'name' : 'description' };
      }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score).map(entry => entry.component);
    }

    if (filter === 'project' && projectId && user) {
      const project = await db
        .select({ spec: projects.spec })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)));
      if (project.length > 0) {
        const spec = project[0].spec as { scenes?: Array<{ component: string }> };
        const componentNames = new Set(spec.scenes?.map(s => s.component) ?? []);
        filteredRows = filteredRows.filter(c => componentNames.has(c.name));
      }
    }

    const result = filteredRows.map(c => ({
      ...c,
      matchedField: query ? (c.name.toLowerCase().includes(query) ? 'name' : 'description') : undefined
    }));

    return reply.send({ items: result });
  });

  app.get('/components/:id', async (request, reply) => {
    const user = request.user as { id: string } | undefined;
    const [row] = await db
      .select()
      .from(components)
      .where(eq(components.id, (request.params as { id: string }).id));
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Component not found', 404),
      );
    // Check access: owner or public
    if (row.userId && row.userId !== user?.id && row.isPublic !== 'true') {
      return sendError(
        reply,
        new AppError('FORBIDDEN', 'Access denied', 403),
      );
    }
    return reply.send(row);
  });

  app.post('/components', async (request, reply) => {
    try {
      const user = request.user as { id: string };
      const input = request.body as Record<string, unknown>;
      check(input);
      const [row] = await db
        .insert(components)
        .values({
          ...input,
          userId: input.isPublic === 'true' ? null : user.id,
          isPublic: input.isPublic ?? 'false',
        } as never)
        .returning();
      return reply.code(201).send(row);
    } catch (error) {
      if (String(error).includes('unique'))
        return sendError(
          reply,
          new AppError('NAME_TAKEN', 'Component name already exists', 409),
        );
      return sendError(reply, error);
    }
  });

  app.put('/components/:id', async (request, reply) => {
    try {
      const user = request.user as { id: string };
      const id = (request.params as { id: string }).id;
      const [existing] = await db
        .select()
        .from(components)
        .where(eq(components.id, id));
      if (!existing)
        throw new AppError('NOT_FOUND', 'Component not found', 404);
      if (existing.userId && existing.userId !== user.id)
        throw new AppError('FORBIDDEN', 'Not your component', 403);

      const input = request.body as Record<string, unknown>;
      check(input);
      const [row] = await db
        .update(components)
        .set({
          ...input,
          userId: input.isPublic === 'true' ? null : user.id,
          isPublic: input.isPublic ?? existing.isPublic,
        } as never)
        .where(eq(components.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Component not found', 404);
      return reply.send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/components/:id', async (request, reply) => {
    const user = request.user as { id: string };
    const id = (request.params as { id: string }).id;
    const [row] = await db
      .select()
      .from(components)
      .where(eq(components.id, id));
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Component not found', 404),
      );
    if (row.userId && row.userId !== user.id)
      return sendError(
        reply,
        new AppError('FORBIDDEN', 'Not your component', 403),
      );
    const used = await db.select({ spec: projects.spec }).from(projects);
    if (
      used.some((project) =>
        JSON.stringify(project.spec).includes(`"component":"${row.name}"`),
      )
    )
      return sendError(
        reply,
        new AppError('IN_USE', 'Component is used by a project', 409),
      );
    await db.delete(components).where(eq(components.id, id));
    return reply.code(204).send();
  });
};