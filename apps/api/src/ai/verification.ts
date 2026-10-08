import { z } from 'zod';
import type { SceneDocument } from '@app/schema';
import {
  boxesOverlap,
  findOverlaps,
  findSceneOverlaps,
  getInstanceBounds,
} from './tools.js';

/**
 * Deterministic result verification (Stage 4B).
 *
 * The model states *what* would mean success; the application re-evaluates
 * those expectations against the authoritative SceneDocument with pure
 * geometry/reference checks. The model never decides that its own change
 * worked, and never inspects pixels — overlap, position, size, existence,
 * and reference validity are all machine-checkable here.
 */

/** Position comparisons allow a 1px tolerance for layout math. */
export const VERIFICATION_POSITION_TOLERANCE = 1;
export const MAX_VERIFICATION_ISSUES = 12;

const TargetRefSchema = z.object({
  instanceId: z.string().uuid().optional(),
  clientKey: z.string().min(1).max(64).optional(),
});

const hasTarget = (ref: { instanceId?: string; clientKey?: string }): boolean =>
  Boolean(ref.instanceId) || Boolean(ref.clientKey);

export const AIAgentInstanceExpectationSchema = z.object({
  ...TargetRefSchema.shape,
  /** Partial: only the provided axis/dimension is compared. */
  expectPosition: z
    .object({
      x: z.number().optional(),
      y: z.number().optional(),
    })
    .optional(),
  expectSize: z
    .object({
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    })
    .optional(),
});

export const AIAgentVerificationSchema = z
  .object({
    /** Listed instances must exist (and satisfy optional position/size). */
    instances: z.array(AIAgentInstanceExpectationSchema).max(16).default([]),
    /** No listed instance pair may overlap each other. */
    noOverlap: z.boolean().default(false),
    /** No listed instance may overlap anything else in the scene. */
    noOverlapWithScene: z.boolean().default(false),
    /** Pairs that MUST overlap (visual connection checks). */
    overlapPairs: z
      .array(z.object({ a: TargetRefSchema, b: TargetRefSchema }))
      .max(8)
      .default([]),
    /** Reference props that must be set and point at an existing instance. */
    references: z
      .array(
        z.object({
          ...TargetRefSchema.shape,
          props: z.array(z.string().min(1).max(120)).min(1).max(5),
        }),
      )
      .max(10)
      .default([]),
  })
  .superRefine((value, ctx) => {
    value.instances.forEach((entry, index) => {
      if (!hasTarget(entry)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instances', index],
          message: 'instanceId or clientKey is required',
        });
      }
    });
    value.references.forEach((entry, index) => {
      if (!hasTarget(entry)) {
        ctx.addIssue({
          code: 'custom',
          path: ['references', index],
          message: 'instanceId or clientKey is required',
        });
      }
    });
    value.overlapPairs.forEach((pair, index) => {
      if (!hasTarget(pair.a) || !hasTarget(pair.b)) {
        ctx.addIssue({
          code: 'custom',
          path: ['overlapPairs', index],
          message: 'both a and b need instanceId or clientKey',
        });
      }
    });
    if (
      value.instances.length === 0 &&
      value.references.length === 0 &&
      value.overlapPairs.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['instances'],
        message:
          'at least one check (instances, references, or overlapPairs) is required',
      });
    }
  });

export type AIAgentVerification = z.infer<typeof AIAgentVerificationSchema>;

export interface AIAgentVerificationOutcome {
  passed: boolean;
  issues: string[];
}

/**
 * Evaluate the model's expectations against the authoritative document.
 * Issues are bounded; an empty list means every check passed.
 */
export const verifySceneExpectations = (input: {
  document: SceneDocument;
  expectations: AIAgentVerification;
  /** clientKey → real id for objects created earlier in this request. */
  clientKeyMap?: ReadonlyMap<string, string>;
}): AIAgentVerificationOutcome => {
  const issues: string[] = [];
  const push = (message: string): void => {
    if (issues.length < MAX_VERIFICATION_ISSUES) issues.push(message);
  };

  const { document, expectations, clientKeyMap } = input;
  const docIds = new Set(document.components.map((c) => c.id));
  const resolve = (ref: { instanceId?: string; clientKey?: string }): string | null => {
    if (ref.instanceId) return ref.instanceId;
    if (ref.clientKey) return clientKeyMap?.get(ref.clientKey) ?? null;
    return null;
  };
  const describe = (ref: { instanceId?: string; clientKey?: string }): string =>
    ref.instanceId ? ref.instanceId : `clientKey "${ref.clientKey}"`;

  const listedIds: string[] = [];
  for (const expectation of expectations.instances) {
    const id = resolve(expectation);
    if (!id) {
      push(`Target ${describe(expectation)} could not be resolved`);
      continue;
    }
    if (!docIds.has(id)) {
      push(`Instance ${id} does not exist`);
      continue;
    }
    listedIds.push(id);
    const bounds = getInstanceBounds(document, id);
    if (!bounds) continue;
    if (expectation.expectPosition) {
      const { x, y } = expectation.expectPosition;
      if (
        x !== undefined &&
        Math.abs(bounds.x - x) > VERIFICATION_POSITION_TOLERANCE
      ) {
        push(`Instance ${id} expected x=${x} but is at x=${bounds.x}`);
      }
      if (
        y !== undefined &&
        Math.abs(bounds.y - y) > VERIFICATION_POSITION_TOLERANCE
      ) {
        push(`Instance ${id} expected y=${y} but is at y=${bounds.y}`);
      }
    }
    if (expectation.expectSize) {
      const { width, height } = expectation.expectSize;
      if (
        width !== undefined &&
        Math.abs(bounds.width - width) > VERIFICATION_POSITION_TOLERANCE
      ) {
        push(`Instance ${id} expected width=${width} but is ${bounds.width}`);
      }
      if (
        height !== undefined &&
        Math.abs(bounds.height - height) > VERIFICATION_POSITION_TOLERANCE
      ) {
        push(`Instance ${id} expected height=${height} but is ${bounds.height}`);
      }
    }
  }

  const seenPairs = new Set<string>();
  const reportPair = (a: string, b: string, message: string): void => {
    const key = [a, b].sort().join('|');
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    push(message);
  };

  if (expectations.noOverlap && listedIds.length >= 2) {
    for (const [a, b] of findOverlaps(document, listedIds)) {
      reportPair(a, b, `Instances ${a} and ${b} overlap`);
    }
  }
  if (expectations.noOverlapWithScene && listedIds.length >= 1) {
    for (const [a, b] of findSceneOverlaps(document, listedIds)) {
      reportPair(a, b, `Instance ${a} overlaps ${b}`);
    }
  }

  for (const pair of expectations.overlapPairs) {
    const a = resolve(pair.a);
    const b = resolve(pair.b);
    if (!a || !b || !docIds.has(a) || !docIds.has(b)) {
      push(
        `Overlap pair ${describe(pair.a)} / ${describe(pair.b)} references an instance that does not exist`,
      );
      continue;
    }
    const boundsA = getInstanceBounds(document, a);
    const boundsB = getInstanceBounds(document, b);
    if (boundsA && boundsB && !boxesOverlap(boundsA, boundsB)) {
      push(`Instances ${a} and ${b} were expected to overlap but do not`);
    }
  }

  for (const reference of expectations.references) {
    const id = resolve(reference);
    if (!id || !docIds.has(id)) {
      push(`Reference target ${describe(reference)} does not exist`);
      continue;
    }
    const instance = document.components.find((c) => c.id === id);
    if (!instance) continue;
    const props = (instance.props ?? {}) as Record<string, unknown>;
    for (const prop of reference.props) {
      const value = props[prop];
      if (typeof value !== 'string' || value === '') {
        push(`Reference prop "${prop}" of ${id} is not set`);
      } else if (!docIds.has(value)) {
        push(`Reference prop "${prop}" of ${id} points at missing instance ${value}`);
      }
    }
  }

  return { passed: issues.length === 0, issues };
};
