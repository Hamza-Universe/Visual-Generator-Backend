import { eq, desc } from 'drizzle-orm';
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
  app.get('/components', async (request, reply) => {
    const query = String((request.query as { query?: string }).query ?? '').trim().toLowerCase();
    const rows = await db.select().from(components).orderBy(desc(components.createdAt));
    if (!query) return reply.send({ items: rows });
    const ranked = rows.map((component) => {
      const name = `${component.name} ${component.displayName}`.toLowerCase();
      const description = component.description.toLowerCase();
      const exact = name === query ? 1000 : 0;
      const namePrefix = name.startsWith(query) ? 700 : 0;
      const nameToken = name.split(/\s+/).some((token) => token.startsWith(query)) ? 500 : 0;
      const descriptionMatch = description.includes(query) ? 100 : 0;
      return { component, score: exact + namePrefix + nameToken + descriptionMatch, matchedField: exact || namePrefix || nameToken ? 'name' : 'description' };
    }).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score);
    return reply.send({ items: ranked.map((entry) => ({ ...entry.component, matchedField: entry.matchedField })) });
  });
  app.get('/components/:id', async (request, reply) => {
    const [row] = await db
      .select()
      .from(components)
      .where(eq(components.id, (request.params as { id: string }).id));
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Component not found', 404),
      );
    return reply.send(row);
  });
  app.post('/components', async (request, reply) => {
    try {
      const input = request.body as Record<string, unknown>;
      check(input);
      const [row] = await db
        .insert(components)
        .values(input as never)
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
      const input = request.body as Record<string, unknown>;
      check(input);
      const [row] = await db
        .update(components)
        .set(input as never)
        .where(eq(components.id, (request.params as { id: string }).id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 'Component not found', 404);
      return reply.send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.delete('/components/:id', async (request, reply) => {
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
