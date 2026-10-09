import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { requireAccessibleDefinition, requireSceneAccess } from '../src/services/documents.js';
import { createDb, components, projects, scenes, users } from '@app/db';

/**
 * Resource-ownership checks against the REAL database and the REAL service
 * helpers. Fixtures are created with unique ids and removed in afterAll, so the
 * shared database is left unchanged. This replaces an earlier fake-DB approach
 * that guessed at drizzle predicate internals and was discarded.
 */

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const tag = `ownership-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let userA = '';
let userB = '';
let projectA = '';
let sceneA = '';
let privateDefA = '';
let privateDefB = '';
let publicDef = '';

const createdDefinitionIds: string[] = [];

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ name: 'Owner A', email: `${tag}-a@example.test`, passwordHash: 'x' })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ name: 'Other B', email: `${tag}-b@example.test`, passwordHash: 'x' })
    .returning({ id: users.id });
  userA = a.id;
  userB = b.id;

  const [p] = await db
    .insert(projects)
    .values({ name: `${tag} project`, spec: {}, userId: userA })
    .returning({ id: projects.id });
  projectA = p.id;

  const [s] = await db
    .insert(scenes)
    .values({ projectId: projectA, name: `${tag} scene` })
    .returning({ id: scenes.id });
  sceneA = s.id;

  const defs = await db
    .insert(components)
    .values([
      { name: `${tag}-public`, displayName: 'Public', description: 'd', propsSchema: {}, enterStyles: [], userId: null, isPublic: true },
      { name: `${tag}-priv-a`, displayName: 'PrivA', description: 'd', propsSchema: {}, enterStyles: [], userId: userA, isPublic: false },
      { name: `${tag}-priv-b`, displayName: 'PrivB', description: 'd', propsSchema: {}, enterStyles: [], userId: userB, isPublic: false },
    ])
    .returning({ id: components.id, name: components.name });
  for (const d of defs) {
    createdDefinitionIds.push(d.id);
    if (d.name.endsWith('-public')) publicDef = d.id;
    if (d.name.endsWith('-priv-a')) privateDefA = d.id;
    if (d.name.endsWith('-priv-b')) privateDefB = d.id;
  }
});

afterAll(async () => {
  // Children first to satisfy foreign keys; users cascade-delete their projects.
  if (sceneA) await db.delete(scenes).where(eq(scenes.id, sceneA));
  if (projectA) await db.delete(projects).where(eq(projects.id, projectA));
  for (const id of createdDefinitionIds) await db.delete(components).where(eq(components.id, id));
  for (const id of [userA, userB]) if (id) await db.delete(users).where(eq(users.id, id));
});

describe('requireSceneAccess (scene ownership, real database)', () => {
  it('returns the scene for its owner', async () => {
    const { scene } = await requireSceneAccess(db, sceneA, userA);
    expect(scene.id).toBe(sceneA);
  });

  it('refuses another user with 403 and does not return the scene', async () => {
    const attempt = requireSceneAccess(db, sceneA, userB);
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('returns 404 for a scene that does not exist', async () => {
    await expect(
      requireSceneAccess(db, '00000000-0000-4000-8000-0000000000ff', userA),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});

describe('requireAccessibleDefinition (component visibility, real database)', () => {
  it('lets any user read a public definition', async () => {
    const def = await requireAccessibleDefinition(db, publicDef, userB);
    expect(def.id).toBe(publicDef);
  });

  it('lets the owner read their private definition', async () => {
    const def = await requireAccessibleDefinition(db, privateDefA, userA);
    expect(def.id).toBe(privateDefA);
  });

  it("refuses another user's private definition with 403", async () => {
    await expect(requireAccessibleDefinition(db, privateDefB, userA)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('returns 404 for an unknown definition id', async () => {
    await expect(
      requireAccessibleDefinition(db, '00000000-0000-4000-8000-0000000000fe', userA),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
