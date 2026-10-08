import { and, eq } from 'drizzle-orm';
import {
  componentInstances,
  components,
  groups,
  projects,
  scenes,
} from '@app/db';
import type { Database } from '@app/db';
import {
  assertSameScene,
  assertValidInstanceReferences,
  isComponentVisibleToUser,
  resolveInstanceProps,
  wouldCreateGroupCycle,
  type CreateGroupInput,
  type CreateInstanceInput,
  type UpdateGroupInput,
  type UpdateInstanceInput,
} from '@app/schema';
import { AppError } from '../errors.js';

export const requireSceneAccess = async (
  db: Database,
  sceneId: string,
  userId: string,
) => {
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, sceneId));
  if (!scene) throw new AppError('NOT_FOUND', 'Scene not found', 404);
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scene.projectId), eq(projects.userId, userId)));
  if (!project)
    throw new AppError('FORBIDDEN', 'Scene is not accessible', 403);
  return { scene, project };
};

export const requireAccessibleDefinition = async (
  db: Database,
  definitionId: string,
  userId: string,
) => {
  const [definition] = await db
    .select()
    .from(components)
    .where(eq(components.id, definitionId));
  if (!definition)
    throw new AppError('NOT_FOUND', 'Component definition not found', 404);
  if (!isComponentVisibleToUser(definition, userId))
    throw new AppError('FORBIDDEN', 'Component is not accessible', 403);
  return definition;
};

const toInstanceResponse = (row: typeof componentInstances.$inferSelect) => ({
  id: row.id,
  sceneId: row.sceneId,
  componentDefinitionId: row.componentDefinitionId,
  groupId: row.groupId,
  props: row.props,
  position: row.position,
  size: row.size,
  transform: row.transform,
  style: row.style,
  visible: row.visible,
  zIndex: row.zIndex,
  timing: row.timing,
  animation: row.animation,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const createScene = async (
  db: Database,
  projectId: string,
  userId: string,
  input: { name: string; description?: string | null; duration?: number | null; meta?: Record<string, unknown> | null },
) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new AppError('NOT_FOUND', 'Project not found', 404);
  const [row] = await db
    .insert(scenes)
    .values({
      projectId,
      name: input.name,
      description: input.description ?? null,
      duration: input.duration ?? null,
      meta: input.meta ?? null,
    })
    .returning();
  return row;
};

export const listProjectScenes = async (
  db: Database,
  projectId: string,
  userId: string,
) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!project) throw new AppError('NOT_FOUND', 'Project not found', 404);
  return db.select().from(scenes).where(eq(scenes.projectId, projectId));
};

export const getSceneDocument = async (
  db: Database,
  sceneId: string,
  userId: string,
) => {
  const { scene } = await requireSceneAccess(db, sceneId, userId);
  const [instanceRows, groupRows] = await Promise.all([
    db.select().from(componentInstances).where(eq(componentInstances.sceneId, sceneId)),
    db.select().from(groups).where(eq(groups.sceneId, sceneId)),
  ]);
  return {
    id: scene.id,
    projectId: scene.projectId,
    name: scene.name,
    description: scene.description,
    duration: scene.duration,
    meta: scene.meta,
    components: instanceRows.map(toInstanceResponse),
    groups: groupRows,
  };
};

export const createInstance = async (
  db: Database,
  sceneId: string,
  userId: string,
  input: CreateInstanceInput,
) => {
  await requireSceneAccess(db, sceneId, userId);
  const definition = await requireAccessibleDefinition(db, input.componentDefinitionId, userId);
  if (input.groupId) {
    const [group] = await db.select().from(groups).where(eq(groups.id, input.groupId));
    if (!group) throw new AppError('NOT_FOUND', 'Group not found', 404);
    assertSameScene(sceneId, [{ sceneId: group.sceneId, label: 'Group' }]);
  }
  const props = resolveInstanceProps(
    {
      propsSchema: definition.propsSchema,
      defaultProps: (definition.defaultProps ?? {}) as Record<string, unknown>,
    },
    (input.props ?? {}) as Record<string, unknown>,
  );
  if (definition.refProps && definition.refProps.length > 0) {
    const siblings = await db
      .select({ id: componentInstances.id })
      .from(componentInstances)
      .where(eq(componentInstances.sceneId, sceneId));
    assertValidInstanceReferences(
      definition.refProps,
      props,
      siblings.map((row) => row.id),
    );
  }
  const [row] = await db
    .insert(componentInstances)
    .values({
      sceneId,
      componentDefinitionId: definition.id,
      groupId: input.groupId ?? null,
      props,
      position: input.position ?? { x: 0, y: 0 },
      size: input.size ?? { width: 100, height: 100 },
      transform: input.transform ?? { rotation: 0, scaleX: 1, scaleY: 1 },
      style: input.style ?? { opacity: 1 },
      visible: input.visible ?? true,
      zIndex: input.zIndex ?? 0,
      timing: input.timing ?? { start: 0, duration: 2 },
      animation: input.animation ?? { enter: [], exit: [], keyframes: [] },
    })
    .returning();
  return toInstanceResponse(row);
};

export const getInstance = async (
  db: Database,
  instanceId: string,
  userId: string,
) => {
  const [row] = await db
    .select()
    .from(componentInstances)
    .where(eq(componentInstances.id, instanceId));
  if (!row) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
  await requireSceneAccess(db, row.sceneId, userId);
  return toInstanceResponse(row);
};

export const listSceneInstances = async (
  db: Database,
  sceneId: string,
  userId: string,
) => {
  await requireSceneAccess(db, sceneId, userId);
  const rows = await db
    .select()
    .from(componentInstances)
    .where(eq(componentInstances.sceneId, sceneId));
  return rows.map(toInstanceResponse);
};

export const updateInstance = async (
  db: Database,
  instanceId: string,
  userId: string,
  input: UpdateInstanceInput,
) => {
  const [existing] = await db
    .select()
    .from(componentInstances)
    .where(eq(componentInstances.id, instanceId));
  if (!existing) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
  await requireSceneAccess(db, existing.sceneId, userId);

  const patch: Partial<typeof componentInstances.$inferInsert> = {};
  if (input.groupId !== undefined) {
    if (input.groupId) {
      const [group] = await db.select().from(groups).where(eq(groups.id, input.groupId));
      if (!group) throw new AppError('NOT_FOUND', 'Group not found', 404);
      assertSameScene(existing.sceneId, [{ sceneId: group.sceneId, label: 'Group' }]);
    }
    patch.groupId = input.groupId;
  }
  let definitionId = existing.componentDefinitionId;
  if (input.componentDefinitionId && input.componentDefinitionId !== existing.componentDefinitionId) {
    const definition = await requireAccessibleDefinition(db, input.componentDefinitionId, userId);
    definitionId = definition.id;
    patch.componentDefinitionId = definition.id;
  }
  if (input.props !== undefined || patch.componentDefinitionId) {
    const [definition] = await db
      .select()
      .from(components)
      .where(eq(components.id, definitionId));
    if (!definition) throw new AppError('NOT_FOUND', 'Component definition not found', 404);
    const base = input.props !== undefined
      ? (input.props as Record<string, unknown>)
      : (existing.props as Record<string, unknown>);
    // When switching definitions without explicit props, start from new defaults.
    const supplied = input.props !== undefined ? base : {};
    patch.props = resolveInstanceProps(
      {
        propsSchema: definition.propsSchema,
        defaultProps: (definition.defaultProps ?? {}) as Record<string, unknown>,
      },
      supplied,
    );
    if (definition.refProps && definition.refProps.length > 0) {
      const siblings = await db
        .select({ id: componentInstances.id })
        .from(componentInstances)
        .where(eq(componentInstances.sceneId, existing.sceneId));
      assertValidInstanceReferences(
        definition.refProps,
        patch.props as Record<string, unknown>,
        siblings.map((row) => row.id),
      );
    }
  }
  if (input.position !== undefined) patch.position = input.position;
  if (input.size !== undefined) patch.size = input.size;
  if (input.transform !== undefined) patch.transform = input.transform;
  if (input.style !== undefined) patch.style = input.style;
  if (input.visible !== undefined) patch.visible = input.visible;
  if (input.zIndex !== undefined) patch.zIndex = input.zIndex;
  if (input.timing !== undefined) patch.timing = input.timing;
  if (input.animation !== undefined) patch.animation = input.animation;

  const [row] = await db
    .update(componentInstances)
    .set(patch)
    .where(eq(componentInstances.id, instanceId))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
  return toInstanceResponse(row);
};

export const deleteInstance = async (
  db: Database,
  instanceId: string,
  userId: string,
) => {
  const [existing] = await db
    .select()
    .from(componentInstances)
    .where(eq(componentInstances.id, instanceId));
  if (!existing) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
  await requireSceneAccess(db, existing.sceneId, userId);
  await db.delete(componentInstances).where(eq(componentInstances.id, instanceId));
};

export const createGroup = async (
  db: Database,
  sceneId: string,
  userId: string,
  input: CreateGroupInput,
) => {
  await requireSceneAccess(db, sceneId, userId);
  if (input.parentGroupId) {
    const [parent] = await db.select().from(groups).where(eq(groups.id, input.parentGroupId));
    if (!parent) throw new AppError('NOT_FOUND', 'Parent group not found', 404);
    assertSameScene(sceneId, [{ sceneId: parent.sceneId, label: 'Parent group' }]);
  }
  const [row] = await db
    .insert(groups)
    .values({
      sceneId,
      parentGroupId: input.parentGroupId ?? null,
      name: input.name,
      zIndex: input.zIndex ?? 0,
    })
    .returning();
  return row;
};

export const listSceneGroups = async (
  db: Database,
  sceneId: string,
  userId: string,
) => {
  await requireSceneAccess(db, sceneId, userId);
  return db.select().from(groups).where(eq(groups.sceneId, sceneId));
};

export const updateGroup = async (
  db: Database,
  groupId: string,
  userId: string,
  input: UpdateGroupInput,
) => {
  const [existing] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!existing) throw new AppError('NOT_FOUND', 'Group not found', 404);
  await requireSceneAccess(db, existing.sceneId, userId);
  if (input.parentGroupId !== undefined) {
    if (input.parentGroupId) {
      const [parent] = await db.select().from(groups).where(eq(groups.id, input.parentGroupId));
      if (!parent) throw new AppError('NOT_FOUND', 'Parent group not found', 404);
      assertSameScene(existing.sceneId, [{ sceneId: parent.sceneId, label: 'Parent group' }]);
      const siblings = await db.select().from(groups).where(eq(groups.sceneId, existing.sceneId));
      if (wouldCreateGroupCycle(siblings, groupId, input.parentGroupId))
        throw new AppError('BAD_INPUT', 'Group nesting would create a cycle', 400);
    }
  }
  const [row] = await db
    .update(groups)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentGroupId !== undefined ? { parentGroupId: input.parentGroupId } : {}),
      ...(input.zIndex !== undefined ? { zIndex: input.zIndex } : {}),
    })
    .where(eq(groups.id, groupId))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', 'Group not found', 404);
  return row;
};

export const deleteGroup = async (
  db: Database,
  groupId: string,
  userId: string,
) => {
  const [existing] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!existing) throw new AppError('NOT_FOUND', 'Group not found', 404);
  await requireSceneAccess(db, existing.sceneId, userId);
  await db.delete(groups).where(eq(groups.id, groupId));
};

export const addInstanceToGroup = async (
  db: Database,
  groupId: string,
  instanceId: string,
  userId: string,
) => updateInstance(db, instanceId, userId, { groupId });

export const removeInstanceFromGroup = async (
  db: Database,
  instanceId: string,
  userId: string,
) => {
  const [existing] = await db
    .select()
    .from(componentInstances)
    .where(eq(componentInstances.id, instanceId));
  if (!existing) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
  await requireSceneAccess(db, existing.sceneId, userId);
  const [row] = await db
    .update(componentInstances)
    .set({ groupId: null })
    .where(eq(componentInstances.id, instanceId))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
  return toInstanceResponse(row);
};

// Fine-grained domain operations (single mutation layer for frontend/MCP/agents)
export const moveComponent = (
  db: Database,
  instanceId: string,
  userId: string,
  position: { x: number; y: number },
) => updateInstance(db, instanceId, userId, { position });

export const resizeComponent = (
  db: Database,
  instanceId: string,
  userId: string,
  size: { width: number; height: number },
) => updateInstance(db, instanceId, userId, { size });

export const updateComponentProps = (
  db: Database,
  instanceId: string,
  userId: string,
  props: Record<string, unknown>,
) => updateInstance(db, instanceId, userId, { props });

export const updateComponentStyle = (
  db: Database,
  instanceId: string,
  userId: string,
  style: Record<string, unknown>,
) => updateInstance(db, instanceId, userId, { style: style as never });

export const setComponentVisibility = (
  db: Database,
  instanceId: string,
  userId: string,
  visible: boolean,
) => updateInstance(db, instanceId, userId, { visible });

export const moveGroup = (
  db: Database,
  groupId: string,
  userId: string,
  input: { parentGroupId?: string | null; zIndex?: number },
) => updateGroup(db, groupId, userId, input);
