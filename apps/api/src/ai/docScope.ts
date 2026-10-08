import type { SceneDocument } from '@app/schema';
import { MOTION_ISSUE_CODES } from '@app/render';

/**
 * Shared document-scope helpers for Stage 4C layout and Stage 4D motion
 * (Stage 4D extracted them from `apply.ts` so validation, application, and
 * verification all expand scopes through ONE implementation instead of
 * three drifting copies).
 *
 * Phase-agnostic by design: the same expansion runs against
 *   - validation (ids may be plan clientKeys for instances created earlier),
 *   - application (clientKeys already resolved to real ids),
 *   - verification (clientKey → id from the request-scoped map),
 * with the resolver closures supplied by each caller.
 */

/** All instance ids belonging to a group, nested subgroups included (document order). */
export const instanceIdsInGroup = (document: SceneDocument, groupId: string): Set<string> => {
  const parentOf = new Map(
    document.groups.map((group) => [group.id, group.parentGroupId ?? null]),
  );
  const isMember = (candidate: string | null | undefined): boolean => {
    let cursor = candidate ?? null;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === groupId) return true;
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    return false;
  };
  return new Set(
    document.components
      .filter((component) => isMember(component.groupId))
      .map((component) => component.id),
  );
};

/**
 * Canvas for layout/motion: the scene's meta width/height when present and
 * valid, otherwise undefined so engines fall back to the canonical WORLD box.
 */
export const layoutCanvasOf = (
  document: SceneDocument,
): { width: number; height: number } | undefined => {
  const meta = (document.meta ?? {}) as Record<string, unknown>;
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }
  return undefined;
};

export interface MotionScopeGroupRef {
  groupId?: string;
  groupClientKey?: string;
}

export interface MotionScopeInput {
  /** Explicit refs in plan order (clientKeys resolvable by the caller). */
  targets?: Array<{ instanceId?: string; clientKey?: string }> | null;
  groupId?: string | null;
  groupClientKey?: string | null;
  /** Resolve one target ref to its identity (document id or plan clientKey). */
  resolveTarget: (ref: { instanceId?: string; clientKey?: string }) => string | null;
  /** Resolve the group ref to a group identity (document id or plan clientKey). */
  resolveGroup: (ref: MotionScopeGroupRef) => string | null;
  /** Ordered member instance ids for a resolved group identity. */
  groupMembers: (groupIdentity: string) => string[];
}

export type MotionScopeResult =
  | { ids: string[] }
  | { error: { path: string; code: string; message: string } };

/** Server-owned cap on the resolved scope (explicit refs ∪ group members). */
export const MOTION_MAX_RESOLVED_SCOPE = 500;

/**
 * Resolve a motion operation's scope to an ordered, deduplicated id list:
 * explicit targets first (plan order), then group members (document order).
 * Keep-first deduplication keeps choreography order stable regardless of how
 * a target was addressed. Never throws — failures come back as the same
 * MOTION_* codes the validator surfaces.
 */
export const resolveMotionScope = (input: MotionScopeInput): MotionScopeResult => {
  const hasScope =
    (input.targets != null && input.targets.length > 0) ||
    Boolean(input.groupId) ||
    Boolean(input.groupClientKey);
  if (!hasScope) {
    return {
      error: {
        path: 'targets',
        code: MOTION_ISSUE_CODES.TARGET_NOT_FOUND,
        message: 'motion requires targets or a group scope',
      },
    };
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null): void => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  let error: { path: string; code: string; message: string } | null = null;

  (input.targets ?? []).forEach((ref, index) => {
    if (error) return;
    const resolved = input.resolveTarget(ref);
    if (!resolved) {
      // One deterministic message covers missing, deleted-earlier, and
      // never-created references.
      error = {
        path: `targets.${index}`,
        code: MOTION_ISSUE_CODES.TARGET_NOT_FOUND,
        message:
          'Motion target does not exist in this scene, was deleted earlier in this plan, or was not created earlier in this plan',
      };
      return;
    }
    push(resolved);
  });
  if (error) return { error };

  if (input.groupId || input.groupClientKey) {
    const groupRef: MotionScopeGroupRef = {
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.groupClientKey ? { groupClientKey: input.groupClientKey } : {}),
    };
    const groupPath = input.groupId ? 'groupId' : 'groupClientKey';
    const identity = input.resolveGroup(groupRef);
    if (!identity) {
      return {
        error: {
          path: groupPath,
          code: MOTION_ISSUE_CODES.TARGET_NOT_FOUND,
          message: 'Group does not exist in this scene (or was not created earlier in this plan)',
        },
      };
    }
    const members = input.groupMembers(identity);
    if (members.length === 0) {
      return {
        error: {
          path: groupPath,
          code: MOTION_ISSUE_CODES.TARGET_NOT_FOUND,
          message: 'Group scope resolved to no instances',
        },
      };
    }
    for (const member of members) push(member);
  }

  if (ids.length > MOTION_MAX_RESOLVED_SCOPE) {
    return {
      error: {
        path: 'targets',
        code: MOTION_ISSUE_CODES.TARGET_LIMIT,
        message: `motion scope resolves to ${ids.length} instances; the server allows at most ${MOTION_MAX_RESOLVED_SCOPE}`,
      },
    };
  }
  return { ids };
};
