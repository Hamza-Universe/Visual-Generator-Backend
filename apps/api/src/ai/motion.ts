import {
  MOTION_ISSUE_CODES,
  findMotionConflicts,
  planMotionWindows,
  type MotionCompileRequest,
  type MotionPlanItem,
  type MotionRawKeyframeOp,
  type MotionTargetInput,
} from '@app/render';
import { resolveSceneTimeline, type SceneDocument } from '@app/schema';
import { layoutCanvasOf } from './docScope.js';

/**
 * AI motion integration (Stage 4D): the bridge between the `motion`
 * operation and the deterministic engine in `@app/render`.
 *
 * Scope resolution lives in `docScope.ts` (shared with layout); this module
 * turns a resolved id list into engine targets, runs the engine's semantic
 * validation (MOTION_* codes as plan issues), collects planned windows for
 * order-independent conflict detection, and builds the post-apply targets
 * the verification step recompiles against.
 *
 * Motion is NOT persisted as its own structure: applying a motion operation
 * merges ordinary AnimationTracks through the existing `updateInstance`
 * mutation path, so the document keeps exactly one animation model.
 */

export interface MotionPlanIssue {
  opIndex: number;
  path: string;
  code: string;
  message: string;
}

const toPlanIssue = (opIndex: number, issue: { path: string; code: string; message: string }): MotionPlanIssue => ({
  opIndex,
  path: issue.path,
  code: issue.code,
  message: issue.message,
});

/**
 * The document base values of an instance — the authoritative geometry a
 * motion compiles against (never the animated values). Stage 4C layout
 * positions are what the engine reads here, so `slideIn(left)` distances
 * derive from real layout bounds while the model only supplies intent.
 */
const baseValuesOf = (component: SceneDocument['components'][number]): MotionTargetInput['base'] => {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    position: {
      x: num(component.position?.x, 0),
      y: num(component.position?.y, 0),
    },
    size: {
      width: num(component.size?.width, 100),
      height: num(component.size?.height, 100),
    },
    transform: {
      rotation: num(component.transform?.rotation, 0),
      scaleX: num(component.transform?.scaleX, 1),
      scaleY: num(component.transform?.scaleY, 1),
    },
    style: { opacity: num(component.style?.opacity, 1) },
  };
};

const SYNTHETIC_BASE: MotionTargetInput['base'] = {
  position: { x: 0, y: 0 },
  size: { width: 100, height: 100 },
  transform: { rotation: 0, scaleX: 1, scaleY: 1 },
  style: { opacity: 1 },
};

/**
 * Build engine targets in scope order.
 *  - `synthesizeMissing: true` (validation) fills not-yet-created instances
 *    with the documented creation defaults so choreography ranks/windows can
 *    be planned before they exist — validation never depends on geometry it
 *    cannot know, and the synthesized values only affect emitted keyframe
 *    values, which are recompiled from the real document at apply time.
 *  - `synthesizeMissing: false` (apply/verification) reports missing ids so
 *    the caller can fail loudly instead of animating a phantom.
 */
export const buildMotionTargets = (
  document: SceneDocument,
  ids: string[],
  options: { synthesizeMissing: boolean },
): { targets: MotionTargetInput[]; missing: string[] } => {
  const targets: MotionTargetInput[] = [];
  const missing: string[] = [];
  const byId = new Map(document.components.map((component) => [component.id, component]));
  for (const id of ids) {
    const component = byId.get(id);
    if (!component) {
      missing.push(id);
      if (options.synthesizeMissing) {
        targets.push({ id, base: SYNTHETIC_BASE, existingTracks: [] });
      }
      continue;
    }
    targets.push({
      id,
      base: baseValuesOf(component),
      existingTracks: (component.animation?.tracks ?? []).map((track) => ({
        property: track.property,
        keyframes: track.keyframes.map((keyframe) => ({
          frame: keyframe.frame,
          value: keyframe.value,
          ...(keyframe.easing ? { easing: keyframe.easing } : {}),
        })),
      })),
    });
  }
  return { targets, missing };
};

export interface MotionOperationLike {
  primitive: unknown;
  options?: unknown;
  timing?: unknown;
  choreography?: unknown;
}

/**
 * Semantic validation of one motion operation against the plan so far:
 * primitive gating, option/timing/choreography rules (engine-issued
 * MOTION_* codes), then order-independent conflict detection against
 * motion windows already collected from earlier operations and against the
 * plan's raw keyframe operations.
 */
export const validateMotionOperation = (input: {
  op: MotionOperationLike;
  opIndex: number;
  /** Resolved, ordered ids (see resolveMotionScope). */
  ids: string[];
  document: SceneDocument;
  priorItems: readonly MotionPlanItem[];
  rawOps: readonly MotionRawKeyframeOp[];
}): { issues: MotionPlanIssue[]; items: MotionPlanItem[] } => {
  const { op, opIndex, document } = input;
  const issues: MotionPlanIssue[] = [];

  if (typeof op.primitive !== 'string' || op.primitive.trim() === '') {
    issues.push(
      toPlanIssue(opIndex, {
        path: 'primitive',
        code: MOTION_ISSUE_CODES.UNSUPPORTED_PRIMITIVE,
        message: 'primitive must be a non-empty motion primitive name',
      }),
    );
    return { issues, items: [] };
  }

  const timeline = resolveSceneTimeline(document);
  const { targets } = buildMotionTargets(document, input.ids, { synthesizeMissing: true });
  const request: MotionCompileRequest = {
    primitive: op.primitive,
    options: (op.options ?? undefined) as Record<string, unknown> | undefined,
    timing: (op.timing ?? undefined) as MotionCompileRequest['timing'],
    choreography: (op.choreography ?? undefined) as MotionCompileRequest['choreography'],
    targets,
    timeline,
    canvas: layoutCanvasOf(document) ?? null,
  };

  const planned = planMotionWindows(request);
  for (const issue of planned.issues) issues.push(toPlanIssue(opIndex, issue));

  const items: MotionPlanItem[] = planned.items.map((item) => ({ ...item, opIndex }));
  for (const conflict of findMotionConflicts({
    items,
    priorItems: input.priorItems,
    rawOps: input.rawOps,
  })) {
    issues.push(toPlanIssue(opIndex, conflict));
  }

  return { issues, items };
};
