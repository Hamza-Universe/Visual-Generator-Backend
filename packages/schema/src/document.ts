import { z } from 'zod';
import * as AjvNamespace from 'ajv';
import * as FormatsNamespace from 'ajv-formats';

export const InstancePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export const SizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
export const TransformSchema = z.object({
  rotation: z.number().default(0),
  scaleX: z.number().default(1),
  scaleY: z.number().default(1),
});
export const StyleSchema = z
  .object({
    opacity: z.number().min(0).max(1).default(1),
  })
  .catchall(z.unknown());
export const TimingSchema = z.object({
  start: z.number().min(0).default(0),
  duration: z.number().positive().default(2),
  // Canonical frame-based timing (Stage 3A). Optional so legacy
  // `{ start, duration }` (seconds) documents keep parsing unchanged.
  // When present, `startFrame`/`durationFrames` take precedence and are
  // resolved with `resolveTimingFrames()`. Convention:
  //   startFrame <= frame < startFrame + durationFrames
  startFrame: z.number().int().min(0).optional(),
  durationFrames: z.number().int().min(0).optional(),
});
export const TimelineEasingSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);
export const AnimatablePropertySchema = z.enum([
  'position.x',
  'position.y',
  'size.width',
  'size.height',
  'transform.rotation',
  'transform.scaleX',
  'transform.scaleY',
  'style.opacity',
]);
export const TimelineKeyframeSchema = z.object({
  frame: z.number().int().min(0),
  value: z.number().finite(),
  easing: TimelineEasingSchema.default('linear'),
});
export const AnimationTrackSchema = z.object({
  property: AnimatablePropertySchema,
  keyframes: z.array(TimelineKeyframeSchema).default([]),
});
export const TimelineSchema = z.object({
  fps: z.number().int().min(1).max(240).default(30),
  durationFrames: z.number().int().min(1).max(864000).default(300),
});
export const AnimationSchema = z.object({
  enter: z.array(z.string()).default([]),
  exit: z.array(z.string()).default([]),
  keyframes: z.array(z.unknown()).default([]),
  // Deterministic property tracks (Stage 3A). Optional so legacy
  // `{ enter, exit, keyframes }` documents keep parsing unchanged.
  tracks: z.array(AnimationTrackSchema).optional(),
});

export const ComponentInstanceSchema = z.object({
  id: z.string().uuid(),
  sceneId: z.string().uuid(),
  componentDefinitionId: z.string().uuid(),
  groupId: z.string().uuid().nullable().optional(),
  props: z.record(z.string(), z.unknown()).default({}),
  position: InstancePositionSchema.default({ x: 0, y: 0 }),
  size: SizeSchema.default({ width: 100, height: 100 }),
  transform: TransformSchema.default({ rotation: 0, scaleX: 1, scaleY: 1 }),
  style: StyleSchema.default({ opacity: 1 }),
  visible: z.boolean().default(true),
  zIndex: z.number().int().default(0),
  timing: TimingSchema.default({ start: 0, duration: 2 }),
  animation: AnimationSchema.default({ enter: [], exit: [], keyframes: [] }),
});

export const GroupSchema = z.object({
  id: z.string().uuid(),
  sceneId: z.string().uuid(),
  parentGroupId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  zIndex: z.number().int().default(0),
});

export const GroupNodeSchema: z.ZodType<{
  id: string;
  sceneId: string;
  parentGroupId?: string | null;
  name: string;
  zIndex: number;
  children: unknown;
}> = GroupSchema.extend({
  children: z.lazy(() => z.array(GroupNodeSchema)),
}) as never;

export const SceneDocumentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
  // Canonical timeline metadata (Stage 3A). Frames are the canonical unit:
  // fps=30, durationFrames=300 means a 10-second scene. Defaulted so legacy
  // documents without `timeline` keep parsing and gain sane defaults.
  timeline: TimelineSchema.default({ fps: 30, durationFrames: 300 }),
  components: z.array(ComponentInstanceSchema).default([]),
  groups: z.array(GroupSchema).default([]),
});

export const ProjectDocumentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scenes: z.array(SceneDocumentSchema).default([]),
});

export type InstancePosition = z.infer<typeof InstancePositionSchema>;
export type Size = z.infer<typeof SizeSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type InstanceStyle = z.infer<typeof StyleSchema>;
export type Timing = z.infer<typeof TimingSchema>;
export type TimelineEasingName = z.infer<typeof TimelineEasingSchema>;
export type AnimatableProperty = z.infer<typeof AnimatablePropertySchema>;
export type TimelineKeyframe = z.infer<typeof TimelineKeyframeSchema>;
export type AnimationTrack = z.infer<typeof AnimationTrackSchema>;
export type SceneTimeline = z.infer<typeof TimelineSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type DocumentComponentInstance = z.infer<typeof ComponentInstanceSchema>;
export type DocumentGroup = z.infer<typeof GroupSchema>;
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;
export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;

export const CreateInstanceInputSchema = z.object({
  componentDefinitionId: z.string().uuid(),
  groupId: z.string().uuid().nullable().optional(),
  props: z.record(z.string(), z.unknown()).default({}),
  position: InstancePositionSchema.default({ x: 0, y: 0 }),
  size: SizeSchema.default({ width: 100, height: 100 }),
  transform: TransformSchema.default({ rotation: 0, scaleX: 1, scaleY: 1 }),
  style: StyleSchema.default({ opacity: 1 }),
  visible: z.boolean().default(true),
  zIndex: z.number().int().default(0),
  timing: TimingSchema.default({ start: 0, duration: 2 }),
  animation: AnimationSchema.default({ enter: [], exit: [], keyframes: [] }),
});
export const UpdateInstanceInputSchema = CreateInstanceInputSchema.partial().extend({
  componentDefinitionId: z.string().uuid().optional(),
});
export const CreateGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentGroupId: z.string().uuid().nullable().optional(),
  zIndex: z.number().int().default(0),
});
export const UpdateGroupInputSchema = CreateGroupInputSchema.partial();
export const CreateSceneInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  duration: z.number().positive().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
  timeline: TimelineSchema.partial().optional(),
});
export const UpdateSceneInputSchema = CreateSceneInputSchema.partial();

export type CreateInstanceInput = z.infer<typeof CreateInstanceInputSchema>;
export type UpdateInstanceInput = z.infer<typeof UpdateInstanceInputSchema>;
export type CreateGroupInput = z.infer<typeof CreateGroupInputSchema>;
export type UpdateGroupInput = z.infer<typeof UpdateGroupInputSchema>;
export type CreateSceneInput = z.infer<typeof CreateSceneInputSchema>;
export type UpdateSceneInput = z.infer<typeof UpdateSceneInputSchema>;

/**
 * Stage 3A timeline helpers (schema layer).
 *
 * Frames are the canonical unit. `Timing` keeps legacy `{ start, duration }`
 * (seconds) for backward compatibility; when `startFrame`/`durationFrames`
 * are present they take precedence. Otherwise legacy seconds convert via
 * `fps`: startFrame = round(start * fps), durationFrames = round(duration * fps).
 *
 * Timing boundary convention (inclusive/exclusive):
 *   visible  <=>  startFrame <= frame < startFrame + durationFrames
 * so startFrame=30, durationFrames=60 is visible on frames 30..89.
 */
export const DEFAULT_TIMELINE_FPS = 30;
export const DEFAULT_TIMELINE_DURATION_FRAMES = 300;

export const resolveSceneTimeline = (scene: {
  timeline?: { fps?: unknown; durationFrames?: unknown } | null;
  duration?: unknown;
}): { fps: number; durationFrames: number } => {
  const raw = scene.timeline ?? {};
  const fps =
    typeof raw.fps === 'number' &&
    Number.isInteger(raw.fps) &&
    raw.fps >= 1 &&
    raw.fps <= 240
      ? raw.fps
      : DEFAULT_TIMELINE_FPS;
  const durationFrames =
    typeof raw.durationFrames === 'number' &&
    Number.isInteger(raw.durationFrames) &&
    raw.durationFrames >= 1
      ? raw.durationFrames
      : typeof scene.duration === 'number' &&
          Number.isFinite(scene.duration) &&
          scene.duration > 0
        ? Math.max(1, Math.round(scene.duration * fps))
        : DEFAULT_TIMELINE_DURATION_FRAMES;
  return { fps, durationFrames };
};

export const resolveTimingFrames = (
  timing:
    | {
        start?: unknown;
        duration?: unknown;
        startFrame?: unknown;
        durationFrames?: unknown;
      }
    | null
    | undefined,
  fps = DEFAULT_TIMELINE_FPS,
): { startFrame: number; durationFrames: number; endFrame: number } => {
  const safeFps =
    typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_TIMELINE_FPS;
  const t = timing ?? {};
  const startFrame =
    typeof t.startFrame === 'number' &&
    Number.isInteger(t.startFrame) &&
    t.startFrame >= 0
      ? t.startFrame
      : typeof t.start === 'number' && Number.isFinite(t.start) && t.start >= 0
        ? Math.max(0, Math.round(t.start * safeFps))
        : 0;
  const durationFrames =
    typeof t.durationFrames === 'number' &&
    Number.isInteger(t.durationFrames) &&
    t.durationFrames >= 0
      ? t.durationFrames
      : typeof t.duration === 'number' && Number.isFinite(t.duration) && t.duration > 0
        ? Math.max(1, Math.round(t.duration * safeFps))
        : DEFAULT_TIMELINE_DURATION_FRAMES;
  return { startFrame, durationFrames, endFrame: startFrame + durationFrames };
};

export const isFrameVisibleAt = (
  timing:
    | {
        start?: unknown;
        duration?: unknown;
        startFrame?: unknown;
        durationFrames?: unknown;
      }
    | null
    | undefined,
  frame: number,
  fps = DEFAULT_TIMELINE_FPS,
): boolean => {
  if (typeof frame !== 'number' || !Number.isFinite(frame)) return false;
  const f = Math.floor(frame);
  const { startFrame, endFrame } = resolveTimingFrames(timing, fps);
  return startFrame <= f && f < endFrame;
};

type AjvValidator = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string }> | null;
};
type AjvLike = new (options?: Record<string, unknown>) => {
  compile(schema: unknown): AjvValidator;
  validateSchema(schema: unknown): boolean;
};

const getAjv = () => {
  const Ajv = AjvNamespace.default as unknown as AjvLike;
  const addFormats = FormatsNamespace.default as unknown as (
    instance: unknown,
  ) => void;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
};

export const resolveInstanceProps = (
  definition: { propsSchema: unknown; defaultProps: Record<string, unknown> },
  supplied: Record<string, unknown> = {},
): Record<string, unknown> => {
  const ajv = getAjv();
  if (
    !definition.propsSchema ||
    typeof definition.propsSchema !== 'object' ||
    !ajv.validateSchema(definition.propsSchema)
  ) {
    throw Object.assign(new Error('Component propsSchema does not compile'), {
      code: 'INVALID_PROPS_SCHEMA',
      statusCode: 500,
    });
  }
  const merged = { ...(definition.defaultProps ?? {}), ...supplied };
  const validator = ajv.compile(definition.propsSchema);
  if (!validator(merged)) {
    throw Object.assign(new Error('Invalid component props'), {
      code: 'INVALID_PROPS',
      statusCode: 400,
      details: (validator.errors ?? []).map((e) => ({
        path: `props${e.instancePath.replaceAll('/', '.')}`,
        code: 'INVALID_PROPS',
        message: e.message ?? 'Invalid props',
      })),
    });
  }
  return merged as Record<string, unknown>;
};

export const assertSameScene = (
  sceneId: string,
  candidates: Array<{ sceneId: string; label: string }>,
): void => {
  for (const candidate of candidates) {
    if (candidate.sceneId !== sceneId) {
      throw Object.assign(
        new Error(`${candidate.label} belongs to a different scene`),
        { code: 'CROSS_SCENE_REFERENCE', statusCode: 400 },
      );
    }
  }
};

/**
 * Generic component-reference validation (Stage 2B).
 *
 * A definition declares reference props via `refProps` (e.g. Arrow's
 * `["from", "to"]`). Each reference value is a ComponentInstance id stored
 * in the instance's own `props` — the same model works for Arrow, Line,
 * Connector, Label, Annotation or any future edge-like component.
 *
 * Rules: empty/missing values mean "unset" and pass; any other value must be
 * the id of an instance in the same scene. Non-string values are rejected by
 * the JSON-schema props validation, so they are ignored here.
 */
export const assertValidInstanceReferences = (
  refProps: string[],
  props: Record<string, unknown>,
  sceneInstanceIds: Iterable<string>,
): void => {
  if (refProps.length === 0) return;
  const ids = sceneInstanceIds instanceof Set ? sceneInstanceIds : new Set(sceneInstanceIds);
  for (const prop of refProps) {
    const value = props[prop];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !ids.has(value)) {
      throw Object.assign(
        new Error(`Reference "${prop}" must be a component in the same scene`),
        { code: 'BAD_REFERENCE', statusCode: 400 },
      );
    }
  }
};

export const isComponentVisibleToUser = (
  row: { userId: string | null; isPublic: boolean },
  userId: string,
): boolean => row.isPublic === true || row.userId === userId;

export const buildGroupTree = (
  groups: Array<{
    id: string;
    sceneId: string;
    parentGroupId?: string | null;
    name: string;
    zIndex: number;
  }>,
): Array<{
  id: string;
  sceneId: string;
  parentGroupId?: string | null;
  name: string;
  zIndex: number;
  children: unknown[];
}> => {
  const byId = new Map(groups.map((g) => [g.id, { ...g, children: [] as unknown[] }]));
  const roots: typeof byId extends Map<string, infer V> ? V[] : never[] = [];
  for (const group of byId.values()) {
    if (group.parentGroupId) {
      const parent = byId.get(group.parentGroupId);
      if (parent) (parent.children as unknown[]).push(group);
      else (roots as unknown[]).push(group);
    } else {
      (roots as unknown[]).push(group);
    }
  }
  return roots as never as Array<{
    id: string;
    sceneId: string;
    parentGroupId?: string | null;
    name: string;
    zIndex: number;
    children: unknown[];
  }>;
};

export const wouldCreateGroupCycle = (
  groups: Array<{ id: string; parentGroupId?: string | null }>,
  groupId: string,
  nextParentId: string | null,
): boolean => {
  if (!nextParentId) return false;
  if (nextParentId === groupId) return true;
  const parentById = new Map(groups.map((g) => [g.id, g.parentGroupId ?? null]));
  let cursor: string | null = nextParentId;
  while (cursor) {
    if (cursor === groupId) return true;
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
};
