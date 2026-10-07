import type { Database } from '@app/db';
import {
  CreateGroupInputSchema,
  CreateInstanceInputSchema,
  SceneDocumentSchema,
  StyleSchema,
  TimelineKeyframeSchema,
  resolveInstanceProps,
  resolveSceneTimeline,
  type AnimationTrack,
  type AnimatableProperty,
  type SceneDocument,
} from '@app/schema';
import { AppError } from '../errors.js';
import {
  createGroup,
  createInstance,
  deleteGroup,
  deleteInstance,
  getSceneDocument,
  requireSceneAccess,
  updateInstance,
} from '../services/documents.js';
import {
  AIScenePlanSchema,
  type AISceneOperation,
  type AIScenePlan,
} from './operations.js';

/**
 * AI plan validation + application (Stage 4A).
 *
 * The AI is an untrusted planner; this layer is the authority. Plans are
 * fully validated against a fresh SceneDocument snapshot BEFORE any
 * mutation, so an invalid plan produces zero database writes. Valid plans
 * apply sequentially through the existing domain mutations in
 * `services/documents.ts` — no second mutation system.
 *
 * Limitation: application is sequential, not transactional. Validation-first
 * eliminates partial mutation from invalid plans; a mid-apply runtime
 * failure (e.g. database outage) is the documented residual risk.
 */

export interface AIPlanDefinition {
  id: string;
  name: string;
  description: string;
  propsSchema: unknown;
  defaultProps: Record<string, unknown>;
  refProps: string[];
}

export interface PlanIssue {
  opIndex: number;
  path: string;
  code: string;
  message: string;
}

type TargetRef = { instanceId?: string; clientKey?: string };
type GroupTargetRef = { groupId?: string; groupClientKey?: string };

const resolveInstanceTarget = (
  ref: TargetRef,
  docIds: Set<string>,
  createdKeys: Set<string>,
): string | null => {
  if (ref.instanceId) return docIds.has(ref.instanceId) ? ref.instanceId : null;
  if (ref.clientKey) return createdKeys.has(ref.clientKey) ? ref.clientKey : null;
  return null;
};

const resolveGroupTarget = (
  ref: GroupTargetRef,
  docIds: Set<string>,
  createdKeys: Set<string>,
): string | null => {
  if (ref.groupId) return docIds.has(ref.groupId) ? ref.groupId : null;
  if (ref.groupClientKey) return createdKeys.has(ref.groupClientKey) ? ref.groupClientKey : null;
  return null;
};

const checkProps = (
  definition: AIPlanDefinition,
  props: Record<string, unknown>,
  opIndex: number,
  path: string,
  issues: PlanIssue[],
): void => {
  try {
    resolveInstanceProps(
      { propsSchema: definition.propsSchema, defaultProps: definition.defaultProps },
      props,
    );
  } catch {
    issues.push({
      opIndex,
      path,
      code: 'AI_OPERATION_INVALID',
      message: `Props do not satisfy the "${definition.name}" schema`,
    });
  }
};

/**
 * Pure plan validation against a document snapshot. Returns every issue
 * found; an empty array means the plan is safe to apply. Never mutates.
 */
export const validateScenePlan = (input: {
  document: SceneDocument;
  definitions: AIPlanDefinition[];
  plan: AIScenePlan;
}): PlanIssue[] => {
  const issues: PlanIssue[] = [];
  const { document, definitions, plan } = input;
  const byName = new Map(definitions.map((d) => [d.name, d]));
  const byId = new Map(document.components.map((c) => [c.id, c]));
  const byDefId = new Map(definitions.map((d) => [d.id, d]));
  const docInstanceIds = new Set(document.components.map((c) => c.id));
  const docGroupIds = new Set(document.groups.map((g) => g.id));
  const createdInstanceKeys = new Set<string>();
  const createdGroupKeys = new Set<string>();
  const seenClientKeys = new Set<string>();
  const timeline = resolveSceneTimeline(document);

  const claimKey = (key: string | undefined, opIndex: number, what: string): boolean => {
    if (!key) return true;
    if (seenClientKeys.has(key)) {
      issues.push({
        opIndex,
        path: 'clientKey',
        code: 'AI_OPERATION_INVALID',
        message: `Duplicate ${what} clientKey "${key}" in plan`,
      });
      return false;
    }
    seenClientKeys.add(key);
    return true;
  };

  plan.operations.forEach((op, opIndex) => {
    switch (op.type) {
      case 'createInstance': {
        if (!claimKey(op.clientKey, opIndex, 'instance')) break;
        const definition = byName.get(op.definitionName);
        if (!definition) {
          issues.push({
            opIndex,
            path: 'definitionName',
            code: 'AI_OPERATION_INVALID',
            message: `Unknown or unauthorized component definition "${op.definitionName}"`,
          });
          break;
        }
        const groupId = op.groupId ?? null;
        const groupKey = op.groupClientKey ?? null;
        if (groupId && !docGroupIds.has(groupId)) {
          issues.push({ opIndex, path: 'groupId', code: 'AI_OPERATION_INVALID', message: 'Group does not exist in this scene' });
        } else if (groupKey && !createdGroupKeys.has(groupKey)) {
          issues.push({ opIndex, path: 'groupClientKey', code: 'AI_OPERATION_INVALID', message: 'Group clientKey is not created earlier in this plan' });
        }
        checkProps(definition, { ...definition.defaultProps, ...(op.props ?? {}) }, opIndex, 'props', issues);
        createdInstanceKeys.add(op.clientKey);
        break;
      }
      case 'createGroup': {
        if (!claimKey(op.clientKey, opIndex, 'group')) break;
        if (op.groupId && !docGroupIds.has(op.groupId)) {
          issues.push({ opIndex, path: 'groupId', code: 'AI_OPERATION_INVALID', message: 'Parent group does not exist in this scene' });
        } else if (op.groupClientKey && !createdGroupKeys.has(op.groupClientKey)) {
          issues.push({ opIndex, path: 'groupClientKey', code: 'AI_OPERATION_INVALID', message: 'Parent group clientKey is not created earlier in this plan' });
        }
        createdGroupKeys.add(op.clientKey);
        break;
      }
      case 'deleteInstance': {
        const target = resolveInstanceTarget(op, docInstanceIds, createdInstanceKeys);
        if (!target) {
          issues.push({ opIndex, path: 'instanceId', code: 'AI_OPERATION_INVALID', message: 'Instance does not exist in this scene' });
          break;
        }
        // Never orphan references: reject deleting an instance that other
        // document instances point at.
        const referenced = document.components.some((c) => {
          const props = (c.props ?? {}) as Record<string, unknown>;
          return Object.values(props).some((v) => v === target);
        });
        if (referenced) {
          issues.push({ opIndex, path: 'instanceId', code: 'AI_OPERATION_INVALID', message: 'Instance is referenced by another component; remove references first' });
        }
        break;
      }
      case 'deleteGroup': {
        const target = resolveGroupTarget(op, docGroupIds, createdGroupKeys);
        if (!target) {
          issues.push({ opIndex, path: 'groupId', code: 'AI_OPERATION_INVALID', message: 'Group does not exist in this scene' });
        }
        break;
      }
      case 'updateInstance':
      case 'moveInstance':
      case 'resizeInstance':
      case 'updateProps':
      case 'updateStyle':
      case 'setVisibility':
      case 'setZIndex': {
        const target = resolveInstanceTarget(op, docInstanceIds, createdInstanceKeys);
        if (!target) {
          issues.push({ opIndex, path: 'instanceId', code: 'AI_OPERATION_INVALID', message: 'Instance does not exist in this scene' });
          break;
        }
        if (op.type === 'updateProps') {
          const current = byId.get(target);
          const definition = current ? byDefId.get(current.componentDefinitionId) : undefined;
          if (current && definition) {
            checkProps(
              definition,
              { ...(current.props as Record<string, unknown>), ...op.props },
              opIndex,
              'props',
              issues,
            );
          }
        }
        if (op.type === 'updateInstance' && op.props) {
          const current = byId.get(target);
          const definition = current ? byDefId.get(current.componentDefinitionId) : undefined;
          if (current && definition) {
            checkProps(definition, { ...(current.props as Record<string, unknown>), ...op.props }, opIndex, 'props', issues);
          }
        }
        break;
      }
      case 'setReference': {
        const target = resolveInstanceTarget(op, docInstanceIds, createdInstanceKeys);
        if (!target) {
          issues.push({ opIndex, path: 'instanceId', code: 'AI_OPERATION_INVALID', message: 'Instance does not exist in this scene' });
          break;
        }
        const current = byId.get(target);
        const definition = current ? byDefId.get(current.componentDefinitionId) : undefined;
        if (current && !definition) {
          issues.push({ opIndex, path: 'instanceId', code: 'AI_OPERATION_INVALID', message: 'Instance definition is not authorized' });
          break;
        }
        if (current && definition && !definition.refProps.includes(op.prop)) {
          issues.push({ opIndex, path: 'prop', code: 'AI_OPERATION_INVALID', message: `"${op.prop}" is not a reference prop of "${definition.name}"` });
          break;
        }
        if (op.targetInstanceId && !docInstanceIds.has(op.targetInstanceId)) {
          issues.push({ opIndex, path: 'targetInstanceId', code: 'AI_OPERATION_INVALID', message: 'Reference target does not exist in this scene' });
        } else if (op.targetClientKey && !createdInstanceKeys.has(op.targetClientKey)) {
          issues.push({ opIndex, path: 'targetClientKey', code: 'AI_OPERATION_INVALID', message: 'Reference target clientKey is not created earlier in this plan' });
        } else if (op.targetInstanceId && op.targetInstanceId === target) {
          issues.push({ opIndex, path: 'targetInstanceId', code: 'AI_OPERATION_INVALID', message: 'An instance cannot reference itself' });
        }
        break;
      }
      case 'addAnimationTrack':
      case 'addKeyframe':
      case 'deleteKeyframe': {
        const target = resolveInstanceTarget(op, docInstanceIds, createdInstanceKeys);
        if (!target) {
          issues.push({ opIndex, path: 'instanceId', code: 'AI_OPERATION_INVALID', message: 'Instance does not exist in this scene' });
          break;
        }
        const frames =
          op.type === 'addAnimationTrack'
            ? op.keyframes.map((k) => k.frame)
            : op.type === 'addKeyframe'
              ? [op.keyframe.frame]
              : [op.frame];
        for (const frame of frames) {
          if (frame >= timeline.durationFrames) {
            issues.push({ opIndex, path: 'frame', code: 'AI_OPERATION_INVALID', message: `Keyframe frame ${frame} is outside the scene duration (${timeline.durationFrames} frames)` });
          }
        }
        break;
      }
      default: {
        issues.push({ opIndex, path: 'type', code: 'AI_OPERATION_INVALID', message: 'Unknown operation type' });
      }
    }
  });

  // Note: createGroup parents always exist (checked above) and fresh group
  // IDs cannot introduce cycles, so no cycle simulation is required.
  return issues;
};

export interface AppliedOperation {
  index: number;
  type: string;
  id: string | null;
}

/**
 * Normalized SceneDocument access for the AI harness. Raw DB rows
 * lack the defaulted `timeline` field, so every document the AI
 * layer touches is parsed through the canonical SceneDocumentSchema
 * first — one canonical visual model, never a second one.
 */
export const fetchSceneDocument = async (
  db: Database,
  sceneId: string,
  userId: string,
): Promise<SceneDocument> =>
  SceneDocumentSchema.parse(await getSceneDocument(db, sceneId, userId));

export interface ApplyScenePlanResult {
  applied: AppliedOperation[];
  document: SceneDocument;
}

const definitionIdFor = (definitions: AIPlanDefinition[], name: string): string => {
  const definition = definitions.find((d) => d.name === name);
  if (!definition) throw new AppError('AI_OPERATION_INVALID', `Unknown definition "${name}"`, 422);
  return definition.id;
};

/**
 * Validate-then-apply a plan through existing domain mutations. Throws
 * AI_OPERATION_INVALID (422) with zero writes when validation fails.
 */
export const applyScenePlan = async (input: {
  db: Database;
  sceneId: string;
  userId: string;
  definitions: AIPlanDefinition[];
  plan: AIScenePlan;
}): Promise<ApplyScenePlanResult> => {
  const { db, sceneId, userId, definitions, plan } = input;
  await requireSceneAccess(db, sceneId, userId);
  const snapshot = await fetchSceneDocument(db, sceneId, userId);
  const issues = validateScenePlan({ document: snapshot, definitions, plan });
  if (issues.length > 0) {
    throw new AppError('AI_OPERATION_INVALID', 'AI plan failed validation; nothing was applied', 422, issues);
  }

  const parsed = AIScenePlanSchema.parse(plan);
  const instanceKeys = new Map<string, string>();
  const groupKeys = new Map<string, string>();
  const applied: AppliedOperation[] = [];

  const instanceIdOf = (ref: { instanceId?: string; clientKey?: string }, op: AISceneOperation): string => {
    if (ref.instanceId) return ref.instanceId;
    const resolved = ref.clientKey ? instanceKeys.get(ref.clientKey) : undefined;
    if (!resolved) throw new AppError('AI_OPERATION_INVALID', 'Unresolved instance reference in plan', 422, [{ op: op.type }]);
    return resolved;
  };
  const groupIdOf = (ref: { groupId?: string; groupClientKey?: string }): string | null => {
    if (ref.groupId) return ref.groupId;
    if (ref.groupClientKey) {
      const resolved = groupKeys.get(ref.groupClientKey);
      if (!resolved) throw new AppError('AI_OPERATION_INVALID', 'Unresolved group reference in plan', 422);
      return resolved;
    }
    return null;
  };

  const currentDocument = async (): Promise<SceneDocument> =>
    fetchSceneDocument(db, sceneId, userId);

  for (const [index, op] of parsed.operations.entries()) {
    switch (op.type) {
      case 'createInstance': {
        const created = await createInstance(
          db,
          sceneId,
          userId,
          CreateInstanceInputSchema.parse({
            componentDefinitionId: definitionIdFor(definitions, op.definitionName),
            ...(groupIdOf(op) ? { groupId: groupIdOf(op) as string } : {}),
            ...(op.props ? { props: op.props } : {}),
            ...(op.position ? { position: op.position } : {}),
            ...(op.size ? { size: op.size } : {}),
            ...(op.transform ? { transform: op.transform } : {}),
            ...(op.style ? { style: op.style } : {}),
            ...(op.visible !== undefined ? { visible: op.visible } : {}),
            ...(op.zIndex !== undefined ? { zIndex: op.zIndex } : {}),
            ...(op.timing ? { timing: op.timing } : {}),
          }),
        );
        instanceKeys.set(op.clientKey, created.id);
        applied.push({ index, type: op.type, id: created.id });
        break;
      }
      case 'updateInstance': {
        const id = instanceIdOf(op, op);
        const patch: Record<string, unknown> = {};
        for (const field of ['position', 'size', 'transform', 'style', 'visible', 'zIndex', 'timing'] as const) {
          if (op[field] !== undefined) patch[field] = op[field];
        }
        if (op.props !== undefined) {
          const doc = await currentDocument();
          const current = doc.components.find((c) => c.id === id);
          if (!current) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
          patch.props = { ...(current.props as Record<string, unknown>), ...op.props };
        }
        await updateInstance(db, id, userId, patch);
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'deleteInstance': {
        const id = instanceIdOf(op, op);
        await deleteInstance(db, id, userId);
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'createGroup': {
        const created = await createGroup(
          db,
          sceneId,
          userId,
          CreateGroupInputSchema.parse({
            name: op.name,
            ...(groupIdOf(op) ? { parentGroupId: groupIdOf(op) as string } : {}),
          }),
        );
        groupKeys.set(op.clientKey, created.id);
        applied.push({ index, type: op.type, id: created.id });
        break;
      }
      case 'deleteGroup': {
        const id = groupIdOf(op);
        if (!id) throw new AppError('AI_OPERATION_INVALID', 'deleteGroup requires a group target', 422);
        await deleteGroup(db, id, userId);
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'moveInstance': {
        const id = instanceIdOf(op, op);
        await updateInstance(db, id, userId, { position: op.position });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'resizeInstance': {
        const id = instanceIdOf(op, op);
        await updateInstance(db, id, userId, { size: op.size });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'updateProps': {
        const id = instanceIdOf(op, op);
        const doc = await currentDocument();
        const current = doc.components.find((c) => c.id === id);
        if (!current) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
        await updateInstance(db, id, userId, {
          props: { ...(current.props as Record<string, unknown>), ...op.props },
        });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'updateStyle': {
        const id = instanceIdOf(op, op);
        const doc = await currentDocument();
        const current = doc.components.find((c) => c.id === id);
        if (!current) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
        await updateInstance(db, id, userId, {
          style: StyleSchema.parse({
            ...(current.style as Record<string, unknown>),
            ...op.style,
          }),
        });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'setVisibility': {
        const id = instanceIdOf(op, op);
        await updateInstance(db, id, userId, { visible: op.visible });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'setZIndex': {
        const id = instanceIdOf(op, op);
        await updateInstance(db, id, userId, { zIndex: op.zIndex });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'setReference': {
        const id = instanceIdOf(op, op);
        const doc = await currentDocument();
        const current = doc.components.find((c) => c.id === id);
        if (!current) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
        const target = op.targetClientKey
          ? (instanceKeys.get(op.targetClientKey) ?? null)
          : (op.targetInstanceId ?? null);
        await updateInstance(db, id, userId, {
          props: { ...(current.props as Record<string, unknown>), [op.prop]: target ?? '' },
        });
        applied.push({ index, type: op.type, id });
        break;
      }
      case 'addAnimationTrack':
      case 'addKeyframe':
      case 'deleteKeyframe': {
        const id = instanceIdOf(op, op);
        const doc = await currentDocument();
        const current = doc.components.find((c) => c.id === id);
        if (!current) throw new AppError('NOT_FOUND', 'Component instance not found', 404);
        const tracks: AnimationTrack[] = (
          current.animation?.tracks ?? []
        ).map((track) => ({ ...track, keyframes: [...track.keyframes] }));
        const ensureTrack = (property: AnimatableProperty): AnimationTrack => {
          let track = tracks.find((t) => t.property === property);
          if (!track) {
            track = { property, keyframes: [] };
            tracks.push(track);
          }
          return track;
        };
        if (op.type === 'addAnimationTrack') {
          const track = ensureTrack(op.property);
          for (const kf of op.keyframes) {
            const at = track.keyframes.findIndex((k) => k.frame === kf.frame);
            const parsed = TimelineKeyframeSchema.parse(kf);
            if (at >= 0) track.keyframes[at] = parsed;
            else track.keyframes.push(parsed);
          }
          track.keyframes.sort((a, b) => a.frame - b.frame);
        } else if (op.type === 'addKeyframe') {
          const track = ensureTrack(op.property);
          const parsed = TimelineKeyframeSchema.parse(op.keyframe);
          const at = track.keyframes.findIndex((k) => k.frame === parsed.frame);
          if (at >= 0) track.keyframes[at] = parsed;
          else track.keyframes.push(parsed);
          track.keyframes.sort((a, b) => a.frame - b.frame);
        } else {
          const remaining = tracks
            .map((t) =>
              t.property === op.property
                ? { ...t, keyframes: t.keyframes.filter((k) => k.frame !== op.frame) }
                : t,
            )
            .filter((t) => t.keyframes.length > 0);
          tracks.length = 0;
          tracks.push(...remaining);
        }
        await updateInstance(db, id, userId, {
          animation: { ...current.animation, tracks },
        });
        applied.push({ index, type: op.type, id });
        break;
      }
    }
  }

  return { applied, document: await currentDocument() };
};

export const parseAIPlan = (value: unknown): AIScenePlan => {
  const parsed = AIScenePlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('AI_SCHEMA_ERROR', 'AI plan does not match the operation schema', 422, parsed.error.issues);
  }
  return parsed.data;
};
