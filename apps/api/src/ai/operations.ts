import { z } from 'zod';
import {
  AnimatablePropertySchema,
  InstancePositionSchema,
  SizeSchema,
  StyleSchema,
  TimelineKeyframeSchema,
  TimingSchema,
  TransformSchema,
} from '@app/schema';

/**
 * AI scene operation plan (Stage 4A).
 *
 * Temporary intent only — never a second document model. Each operation is
 * deterministic and addressable; references use real instance IDs or
 * plan-local clientKeys (for instances/groups created earlier in the same
 * plan). The subset below maps 1:1 onto existing domain mutations in
 * `services/documents.ts` plus animation-track shaping (Stage 3D).
 */

const InstanceRefSchema = z.object({
  instanceId: z.string().uuid().optional(),
  clientKey: z.string().min(1).max(64).optional(),
});

const GroupRefSchema = z.object({
  groupId: z.string().uuid().optional(),
  groupClientKey: z.string().min(1).max(64).optional(),
});

export const AICreateInstanceOperationSchema = z.object({
  type: z.literal('createInstance'),
  clientKey: z.string().min(1).max(64),
  /** Component definition NAME from the AI registry context (never an ID). */
  definitionName: z.string().min(1).max(120),
  ...GroupRefSchema.shape,
  props: z.record(z.string(), z.unknown()).optional(),
  position: InstancePositionSchema.optional(),
  size: SizeSchema.optional(),
  transform: TransformSchema.optional(),
  style: StyleSchema.optional(),
  visible: z.boolean().optional(),
  zIndex: z.number().int().optional(),
  timing: TimingSchema.optional(),
});

export const AIUpdateInstanceOperationSchema = z.object({
  type: z.literal('updateInstance'),
  ...InstanceRefSchema.shape,
  props: z.record(z.string(), z.unknown()).optional(),
  position: InstancePositionSchema.optional(),
  size: SizeSchema.optional(),
  transform: TransformSchema.optional(),
  style: StyleSchema.optional(),
  visible: z.boolean().optional(),
  zIndex: z.number().int().optional(),
  timing: TimingSchema.optional(),
});

export const AIDeleteInstanceOperationSchema = z.object({
  type: z.literal('deleteInstance'),
  ...InstanceRefSchema.shape,
});

export const AICreateGroupOperationSchema = z.object({
  type: z.literal('createGroup'),
  clientKey: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  ...GroupRefSchema.shape,
});

export const AIDeleteGroupOperationSchema = z.object({
  type: z.literal('deleteGroup'),
  ...GroupRefSchema.shape,
});

export const AIMoveInstanceOperationSchema = z.object({
  type: z.literal('moveInstance'),
  ...InstanceRefSchema.shape,
  position: InstancePositionSchema,
});

export const AIResizeInstanceOperationSchema = z.object({
  type: z.literal('resizeInstance'),
  ...InstanceRefSchema.shape,
  size: SizeSchema,
});

export const AIUpdatePropsOperationSchema = z.object({
  type: z.literal('updateProps'),
  ...InstanceRefSchema.shape,
  /** Merged over the instance's current props, then validated. */
  props: z.record(z.string(), z.unknown()),
});

export const AIUpdateStyleOperationSchema = z.object({
  type: z.literal('updateStyle'),
  ...InstanceRefSchema.shape,
  /** Merged over the instance's current style. */
  style: z.record(z.string(), z.unknown()),
});

export const AISetVisibilityOperationSchema = z.object({
  type: z.literal('setVisibility'),
  ...InstanceRefSchema.shape,
  visible: z.boolean(),
});

export const AISetZIndexOperationSchema = z.object({
  type: z.literal('setZIndex'),
  ...InstanceRefSchema.shape,
  zIndex: z.number().int(),
});

export const AISetReferenceOperationSchema = z.object({
  type: z.literal('setReference'),
  ...InstanceRefSchema.shape,
  /** Reference prop name declared by the component definition (e.g. "from"). */
  prop: z.string().min(1).max(120),
  targetInstanceId: z.string().uuid().nullable().optional(),
  targetClientKey: z.string().min(1).max(64).optional(),
});

export const AIAddAnimationTrackOperationSchema = z.object({
  type: z.literal('addAnimationTrack'),
  ...InstanceRefSchema.shape,
  property: AnimatablePropertySchema,
  keyframes: z.array(TimelineKeyframeSchema).min(1).max(120),
});

export const AIAddKeyframeOperationSchema = z.object({
  type: z.literal('addKeyframe'),
  ...InstanceRefSchema.shape,
  property: AnimatablePropertySchema,
  keyframe: TimelineKeyframeSchema,
});

export const AIDeleteKeyframeOperationSchema = z.object({
  type: z.literal('deleteKeyframe'),
  ...InstanceRefSchema.shape,
  property: AnimatablePropertySchema,
  frame: z.number().int().min(0),
});

export const AISceneOperationSchema = z.discriminatedUnion('type', [
  AICreateInstanceOperationSchema,
  AIUpdateInstanceOperationSchema,
  AIDeleteInstanceOperationSchema,
  AICreateGroupOperationSchema,
  AIDeleteGroupOperationSchema,
  AIMoveInstanceOperationSchema,
  AIResizeInstanceOperationSchema,
  AIUpdatePropsOperationSchema,
  AIUpdateStyleOperationSchema,
  AISetVisibilityOperationSchema,
  AISetZIndexOperationSchema,
  AISetReferenceOperationSchema,
  AIAddAnimationTrackOperationSchema,
  AIAddKeyframeOperationSchema,
  AIDeleteKeyframeOperationSchema,
]);

export type AISceneOperation = z.infer<typeof AISceneOperationSchema>;

export const MAX_AI_PLAN_OPERATIONS = 50;

export const AIScenePlanSchema = z.object({
  operations: z.array(AISceneOperationSchema).max(MAX_AI_PLAN_OPERATIONS),
});

export type AIScenePlan = z.infer<typeof AIScenePlanSchema>;
