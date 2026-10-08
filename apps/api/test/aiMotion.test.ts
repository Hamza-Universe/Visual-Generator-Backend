import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SceneDocument } from '@app/schema';
import { AppError } from '../src/errors.js';
import {
  applyScenePlan,
  parseAIPlan,
  validateScenePlan,
  type AIPlanDefinition,
} from '../src/ai/apply.js';
import { buildAIContext, type AIContextInput } from '../src/ai/context.js';
import { verifyAppliedMotion } from '../src/ai/verification.js';
import {
  AGENT_SCENE_INSTRUCTIONS,
  AI_CONTEXT_VERSION,
  buildSystemPrompt,
} from '../src/ai/systemPrompt.js';
import { runSceneAgent } from '../src/ai/agent.js';
import type {
  AISceneProvider,
  AIStructuredRequest,
  AIStructuredResult,
} from '../src/ai/provider.js';
import type { AIScenePlan } from '../src/ai/operations.js';
import {
  createInstance,
  updateInstance,
} from '../src/services/documents.js';

/**
 * Stage 4D — AI semantic motion integration.
 *
 * The documents service is mocked with an in-memory mutable fixture, so the
 * REAL plan → validation → motion engine → mutation pipeline runs end-to-end:
 * the AI names a primitive, `@app/render` compiles it to deterministic
 * keyframes, and they are written back through the existing `updateInstance`
 * mutation path — never a second animation model.
 */

const mockState = vi.hoisted(() => ({ createdCount: 0 }));

vi.mock('../src/services/documents.js', () => ({
  requireSceneAccess: vi.fn(async () => ({ scene: {}, project: {} })),
  getSceneDocument: vi.fn(async () => sceneDocument),
  createInstance: vi.fn(
    async (_db: unknown, _sceneId: string, _userId: string, input: unknown) => {
      const raw = (input ?? {}) as Record<string, unknown>;
      const sequence = mockState.createdCount++;
      const id = `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
      sceneDocument.components.push({
        id,
        sceneId: sceneDocument.id,
        componentDefinitionId: String(raw.componentDefinitionId),
        groupId: (raw.groupId as string | null | undefined) ?? null,
        props: (raw.props as Record<string, unknown> | undefined) ?? {},
        position:
          (raw.position as { x: number; y: number } | undefined) ?? { x: 0, y: 0 },
        size:
          (raw.size as { width: number; height: number } | undefined) ?? {
            width: 100,
            height: 100,
          },
        transform: { rotation: 0, scaleX: 1, scaleY: 1 },
        style: { opacity: 1 },
        visible: raw.visible === undefined ? true : Boolean(raw.visible),
        zIndex: typeof raw.zIndex === 'number' ? raw.zIndex : 0,
        timing: { start: 0, duration: 2 },
        animation: { enter: [], exit: [], keyframes: [] },
      });
      return { id, ...raw };
    },
  ),
  updateInstance: vi.fn(
    async (_db: unknown, id: string, _userId: string, patch: unknown) => {
      const instance = sceneDocument.components.find((c) => c.id === id);
      if (!instance) {
        throw new AppError('NOT_FOUND', 'Component instance not found', 404);
      }
      Object.assign(instance, patch as object);
      return instance;
    },
  ),
  deleteInstance: vi.fn(async (_db: unknown, id: string) => {
    sceneDocument.components = sceneDocument.components.filter((c) => c.id !== id);
  }),
  createGroup: vi.fn(
    async (_db: unknown, _sceneId: string, _userId: string, input: unknown) => ({
      id: '00000000-0000-4000-8000-0000000000ff',
      ...(input as Record<string, unknown>),
    }),
  ),
  deleteGroup: vi.fn(async () => undefined),
}));

const SCENE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const TITLE_ID = '55555555-5555-4555-8555-555555555555';
const CARD_ID = '66666666-6666-4666-8666-666666666666';
const MEMBER_ID = '99999999-9999-4999-8999-999999999999';
const MISSING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LABEL_DEF_ID = '77777777-7777-4777-8777-777777777777';
const GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBGROUP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EMPTY_GROUP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CREATED_ID = '00000000-0000-4000-8000-000000000000';

const labelDefinition: AIPlanDefinition = {
  id: LABEL_DEF_ID,
  name: 'Label',
  description: 'A text label',
  propsSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, fontSize: { type: 'number' } },
  },
  defaultProps: { text: 'Hello', fontSize: 16 },
  refProps: [],
};

const definitions = [labelDefinition];

/** Registry rows carry visibility + registry fields used by the context pack. */
const registryRows = [
  {
    ...labelDefinition,
    enterStyles: [],
    exitStyles: [],
    colorProps: [],
    assetProps: [],
    userId: null,
    isPublic: true,
  },
] as AIContextInput['definitions'];

const makeComponent = (input: {
  id: string;
  definitionId: string;
  props: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
  groupId?: string | null;
}) => ({
  id: input.id,
  sceneId: SCENE_ID,
  componentDefinitionId: input.definitionId,
  groupId: input.groupId ?? null,
  props: input.props,
  position: input.position,
  size: input.size,
  transform: { rotation: 0, scaleX: 1, scaleY: 1 },
  style: { opacity: 1 },
  visible: true,
  zIndex: 0,
  timing: { start: 0, duration: 2 },
  animation: { enter: [], exit: [], keyframes: [] },
});

/**
 * Fixture (document order matters):
 *   TITLE  {100,100} 300×40   Label, no group
 *   CARD   {100,300} 220×40   Label in GROUP
 *   MEMBER {100,500} 220×40   Label in SUBGROUP (nested under GROUP)
 * Groups: GROUP, SUBGROUP (nested), EMPTY (no members).
 */
const makeSceneDocument = (): SceneDocument =>
  ({
    id: SCENE_ID,
    projectId: PROJECT_ID,
    name: 'Motion scene',
    timeline: { fps: 30, durationFrames: 300 },
    components: [
      makeComponent({
        id: TITLE_ID,
        definitionId: LABEL_DEF_ID,
        props: { text: 'Title', fontSize: 24 },
        position: { x: 100, y: 100 },
        size: { width: 300, height: 40 },
      }),
      makeComponent({
        id: CARD_ID,
        definitionId: LABEL_DEF_ID,
        props: { text: 'Card', fontSize: 24 },
        position: { x: 100, y: 300 },
        size: { width: 220, height: 40 },
        groupId: GROUP_ID,
      }),
      makeComponent({
        id: MEMBER_ID,
        definitionId: LABEL_DEF_ID,
        props: { text: 'Member', fontSize: 16 },
        position: { x: 100, y: 500 },
        size: { width: 220, height: 40 },
        groupId: SUBGROUP_ID,
      }),
    ],
    groups: [
      { id: GROUP_ID, sceneId: SCENE_ID, parentGroupId: null, name: 'Stack', zIndex: 0 },
      { id: SUBGROUP_ID, sceneId: SCENE_ID, parentGroupId: GROUP_ID, name: 'Inner', zIndex: 1 },
      { id: EMPTY_GROUP_ID, sceneId: SCENE_ID, parentGroupId: null, name: 'Empty', zIndex: 0 },
    ],
  }) as SceneDocument;

let sceneDocument: SceneDocument = makeSceneDocument();

/** Scripted provider: validates responses like the real provider does. */
const scriptedProvider = (script: unknown[]) => {
  const requests: AIStructuredRequest[] = [];
  const generate = vi.fn(
    async (
      request: AIStructuredRequest,
      schema: z.ZodType<unknown>,
    ): Promise<AIStructuredResult<unknown>> => {
      requests.push(request);
      const raw = script[Math.min(requests.length - 1, script.length - 1)];
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new AppError(
          'AI_SCHEMA_ERROR',
          'AI response did not match AIAgentTurn',
          502,
          parsed.error.issues as unknown[],
        );
      }
      return {
        data: parsed.data,
        latencyMs: 1,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  );
  return {
    generate,
    requests,
    provider: {
      provider: 'openrouter',
      model: 'test-model',
      generateStructured: generate,
    } as unknown as AISceneProvider,
  };
};

const validate = (operations: unknown[]) =>
  validateScenePlan({
    document: sceneDocument,
    definitions,
    plan: { operations } as unknown as AIScenePlan,
  });

const apply = (operations: unknown[]) =>
  applyScenePlan({
    db: {} as never,
    sceneId: SCENE_ID,
    userId: USER_ID,
    definitions,
    plan: { operations } as unknown as AIScenePlan,
  });

const failureOf = async (operations: unknown[]): Promise<AppError> => {
  try {
    await apply(operations);
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected apply to reject');
};

const schemaErrorOf = (operations: unknown[]): AppError => {
  try {
    parseAIPlan({ operations });
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected parseAIPlan to reject');
};

const storedTracks = (id: string): Array<{ property: string; keyframes: unknown[] }> =>
  (sceneDocument.components.find((c) => c.id === id)?.animation?.tracks ?? []) as Array<{
    property: string;
    keyframes: unknown[];
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  mockState.createdCount = 0;
  sceneDocument = makeSceneDocument();
});

// ---------------------------------------------------------------------------
// Schema (plan parsing)
// ---------------------------------------------------------------------------

describe('AI motion operation schema', () => {
  it('parses motion operations with wire-level defaults', () => {
    const plan = parseAIPlan({
      operations: [
        {
          type: 'motion',
          targets: [{ instanceId: TITLE_ID }],
          primitive: 'fadeIn',
          choreography: { mode: 'stagger', stagger: 0.2 },
        },
      ],
    });
    expect(plan.operations[0]).toMatchObject({
      type: 'motion',
      targets: [{ instanceId: TITLE_ID }],
      primitive: 'fadeIn',
      choreography: { mode: 'stagger', order: 'forward', stagger: 0.2 },
    });
    const op = plan.operations[0] as { timing?: unknown; options?: unknown };
    expect(op.timing).toBeUndefined();
    expect(op.options).toBeUndefined();
  });

  it('accepts group-only scope and every supported primitive name', () => {
    expect(() =>
      parseAIPlan({
        operations: [{ type: 'motion', groupId: GROUP_ID, primitive: 'slideIn' }],
      }),
    ).not.toThrow();
    // Unknown primitive names pass the wire schema; they are gated
    // semantically with MOTION_UNSUPPORTED_PRIMITIVE at validation.
    expect(() =>
      parseAIPlan({
        operations: [{ type: 'motion', groupId: GROUP_ID, primitive: 'sparkle' }],
      }),
    ).not.toThrow();
  });

  it('rejects oversized or malformed fields with AI_SCHEMA_ERROR', () => {
    expect(
      schemaErrorOf([
        {
          type: 'motion',
          targets: Array.from({ length: 201 }, () => ({ instanceId: TITLE_ID })),
          primitive: 'fadeIn',
        },
      ]).code,
    ).toBe('AI_SCHEMA_ERROR');

    expect(
      schemaErrorOf([
        { type: 'motion', groupId: GROUP_ID, primitive: 'x'.repeat(41) },
      ]).code,
    ).toBe('AI_SCHEMA_ERROR');

    expect(
      schemaErrorOf([
        {
          type: 'motion',
          groupId: GROUP_ID,
          primitive: 'fadeIn',
          timing: { duration: 'fast' },
        },
      ]).code,
    ).toBe('AI_SCHEMA_ERROR');

    expect(
      schemaErrorOf([
        {
          type: 'motion',
          groupId: GROUP_ID,
          primitive: 'fadeIn',
          choreography: { mode: 'wave' },
        },
      ]).code,
    ).toBe('AI_SCHEMA_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Validation (MOTION_* codes as plan issues)
// ---------------------------------------------------------------------------

describe('motion plan validation', () => {
  it('accepts an entrance on an explicit instance target', () => {
    expect(
      validate([
        { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
      ]),
    ).toEqual([]);
  });

  it('expands group scopes to nested members', () => {
    expect(
      validate([{ type: 'motion', groupId: GROUP_ID, primitive: 'fadeIn' }]),
    ).toEqual([]);
  });

  it('rejects missing, unknown, and never-created targets', () => {
    const noScope = validate([{ type: 'motion', primitive: 'fadeIn' }]);
    expect(noScope[0]).toMatchObject({
      path: 'targets',
      code: 'MOTION_TARGET_NOT_FOUND',
    });

    const unknown = validate([
      { type: 'motion', targets: [{ instanceId: MISSING_ID }], primitive: 'fadeIn' },
    ]);
    expect(unknown[0]).toMatchObject({
      path: 'targets.0',
      code: 'MOTION_TARGET_NOT_FOUND',
    });

    const unknownKey = validate([
      { type: 'motion', targets: [{ clientKey: 'ghost' }], primitive: 'fadeIn' },
    ]);
    expect(unknownKey[0]).toMatchObject({
      path: 'targets.0',
      code: 'MOTION_TARGET_NOT_FOUND',
    });
  });

  it('rejects unknown and empty group scopes', () => {
    const unknown = validate([
      { type: 'motion', groupId: MISSING_ID, primitive: 'fadeIn' },
    ]);
    expect(unknown[0]).toMatchObject({
      path: 'groupId',
      code: 'MOTION_TARGET_NOT_FOUND',
    });

    const empty = validate([
      { type: 'motion', groupId: EMPTY_GROUP_ID, primitive: 'fadeIn' },
    ]);
    expect(empty[0]).toMatchObject({
      path: 'groupId',
      code: 'MOTION_TARGET_NOT_FOUND',
    });
    expect(empty[0].message).toContain('resolved to no instances');
  });

  it('honors instances deleted earlier in the same plan', () => {
    const issues = validate([
      { type: 'deleteInstance', instanceId: MEMBER_ID },
      { type: 'motion', targets: [{ instanceId: MEMBER_ID }], primitive: 'fadeIn' },
    ]);
    expect(issues[0]).toMatchObject({
      code: 'MOTION_TARGET_NOT_FOUND',
    });

    // A group scope still resolves: the deleted member is simply excluded.
    expect(
      validate([
        { type: 'deleteInstance', instanceId: MEMBER_ID },
        { type: 'motion', groupId: GROUP_ID, primitive: 'fadeIn' },
      ]),
    ).toEqual([]);
  });

  it('gates primitives by capability — never faked', () => {
    const unknown = validate([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'sparkle' },
    ]);
    expect(unknown[0]).toMatchObject({
      path: 'primitive',
      code: 'MOTION_UNSUPPORTED_PRIMITIVE',
    });

    for (const primitive of ['wipeIn', 'typeIn', 'blurIn', 'drawIn', 'cameraPan']) {
      const issues = validate([
        { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive },
      ]);
      expect(issues[0]).toMatchObject({
        path: 'primitive',
        code: 'MOTION_UNSUPPORTED_RENDER_CAPABILITY',
      });
    }
  });

  it('rejects invalid timing with MOTION_INVALID_TIMING', () => {
    const zero = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
        timing: { duration: 0 },
      },
    ]);
    expect(zero[0]).toMatchObject({
      path: 'timing.duration',
      code: 'MOTION_INVALID_TIMING',
    });

    const mismatch = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
        timing: { duration: 1, end: 3 },
      },
    ]);
    expect(mismatch[0]).toMatchObject({
      path: 'timing.end',
      code: 'MOTION_INVALID_TIMING',
    });

    const beyondScene = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
        timing: { start: 100 },
      },
    ]);
    expect(beyondScene[0]).toMatchObject({ code: 'MOTION_INVALID_TIMING' });
    expect(beyondScene[0].message).toContain('beyond the scene duration');
  });

  it('rejects invalid options and choreography with MOTION_INVALID_OPTION', () => {
    const unknownOption = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'move',
        options: { wobble: true },
      },
    ]);
    expect(unknownOption[0]).toMatchObject({
      path: 'options.wobble',
      code: 'MOTION_INVALID_OPTION',
    });

    const noDelta = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'move',
        options: {},
      },
    ]);
    expect(noDelta[0]).toMatchObject({
      path: 'options',
      code: 'MOTION_INVALID_OPTION',
    });

    const badChoreography = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
        choreography: { mode: 'wave' },
      },
    ]);
    expect(badChoreography[0]).toMatchObject({
      path: 'choreography.mode',
      code: 'MOTION_INVALID_OPTION',
    });
  });

  it('rejects overlapping motion windows on the same target + property', () => {
    const issues = validate([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
        timing: { duration: 1 },
      },
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fade',
        options: { from: 0.2, to: 0.6 },
        timing: { start: 0.5, duration: 1 },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      opIndex: 1,
      path: 'timing',
      code: 'MOTION_CONFLICT',
    });
    expect(issues[0].message).toContain('overlaps motion op 0');
  });

  it('allows motion on different properties and touching windows', () => {
    expect(
      validate([
        {
          type: 'motion',
          targets: [{ instanceId: TITLE_ID }],
          primitive: 'fadeIn',
          timing: { duration: 1 },
        },
        {
          type: 'motion',
          targets: [{ instanceId: TITLE_ID }],
          primitive: 'move',
          options: { dx: 40 },
          timing: { start: 1, duration: 1 }, // window starts where the first ends
        },
      ]),
    ).toEqual([]);
  });

  it('detects raw keyframe collisions with a motion window in either order', () => {
    const motion = {
      type: 'motion',
      targets: [{ instanceId: TITLE_ID }],
      primitive: 'fadeIn',
      timing: { duration: 1 }, // window [0, 30]
    };
    const keyframe = {
      type: 'addKeyframe',
      instanceId: TITLE_ID,
      property: 'style.opacity',
      keyframe: { frame: 10, value: 0.5 },
    };

    const motionFirst = validate([motion, keyframe]);
    expect(motionFirst[0]).toMatchObject({ opIndex: 0, code: 'MOTION_CONFLICT' });
    expect(motionFirst[0].message).toContain('addKeyframe op 1 frame 10');

    const keyframeFirst = validate([keyframe, motion]);
    expect(keyframeFirst[0]).toMatchObject({ opIndex: 1, code: 'MOTION_CONFLICT' });
    expect(keyframeFirst[0].message).toContain('addKeyframe op 0 frame 10');

    // Outside the window → no conflict.
    expect(
      validate([
        motion,
        { ...keyframe, keyframe: { frame: 100, value: 0.5 } },
      ]),
    ).toEqual([]);
  });

  it('accepts targets created earlier in the same plan (synthesized geometry)', () => {
    expect(
      validate([
        {
          type: 'createInstance',
          clientKey: 'badge',
          definitionName: 'Label',
          position: { x: 250, y: 40 },
          size: { width: 100, height: 60 },
        },
        {
          type: 'motion',
          targets: [{ clientKey: 'badge' }],
          primitive: 'slideIn',
          options: { direction: 'left' },
        },
      ]),
    ).toEqual([]);
  });

  it('rejects scopes beyond the server-owned resolved-target cap', () => {
    const big = makeSceneDocument();
    const groupId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    big.groups.push({
      id: groupId,
      sceneId: SCENE_ID,
      parentGroupId: null,
      name: 'Huge',
      zIndex: 0,
    });
    big.components = Array.from({ length: 501 }, (_, index) =>
      makeComponent({
        id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        definitionId: LABEL_DEF_ID,
        props: {},
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        groupId,
      }),
    );
    const issues = validateScenePlan({
      document: big,
      definitions,
      plan: {
        operations: [{ type: 'motion', groupId, primitive: 'fadeIn' }],
      } as unknown as AIScenePlan,
    });
    expect(issues[0]).toMatchObject({ code: 'MOTION_TARGET_LIMIT' });
    expect(issues[0].message).toContain('at most 500');
  });
});

// ---------------------------------------------------------------------------
// Application (validation → engine → document mutations)
// ---------------------------------------------------------------------------

describe('motion plan application', () => {
  it('compiles fadeIn into ordinary animation tracks via updateInstance', async () => {
    const result = await apply([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
    ]);

    expect(updateInstance).toHaveBeenCalledTimes(1);
    expect(updateInstance).toHaveBeenNthCalledWith(1, {} as never, TITLE_ID, USER_ID, {
      animation: {
        enter: [],
        exit: [],
        keyframes: [],
        tracks: [
          {
            property: 'style.opacity',
            keyframes: [
              { frame: 0, value: 0, easing: 'easeOut' },
              { frame: 15, value: 1, easing: 'linear' },
            ],
          },
        ],
      },
    });
    expect(result.applied).toEqual([{ index: 0, type: 'motion', id: null }]);
    expect(storedTracks(TITLE_ID)).toEqual([
      {
        property: 'style.opacity',
        keyframes: [
          { frame: 0, value: 0, easing: 'easeOut' },
          { frame: 15, value: 1, easing: 'linear' },
        ],
      },
    ]);
  });

  it('derives slideIn distances from layout bounds — never from the model', async () => {
    await apply([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'slideIn',
        options: { direction: 'left' },
      },
    ]);

    // TITLE sits at x=100 → the engine derives distance 100 → starts at 0.
    expect(storedTracks(TITLE_ID)).toEqual([
      {
        property: 'position.x',
        keyframes: [
          { frame: 0, value: 0, easing: 'easeOut' },
          { frame: 15, value: 100, easing: 'linear' },
        ],
      },
    ]);
  });

  it('animates a plan-created instance through its clientKey with real geometry', async () => {
    const result = await apply([
      {
        type: 'createInstance',
        clientKey: 'badge',
        definitionName: 'Label',
        position: { x: 250, y: 40 },
        size: { width: 100, height: 60 },
      },
      {
        type: 'motion',
        targets: [{ clientKey: 'badge' }],
        primitive: 'slideIn',
        options: { direction: 'left' },
      },
    ]);

    // Validation synthesized base geometry; application compiled against the
    // REAL position {x: 250} → distance 250 → keyframes [0 → 250].
    expect(storedTracks(CREATED_ID)).toEqual([
      {
        property: 'position.x',
        keyframes: [
          { frame: 0, value: 0, easing: 'easeOut' },
          { frame: 15, value: 250, easing: 'linear' },
        ],
      },
    ]);
    expect(result.applied).toEqual([
      { index: 0, type: 'createInstance', id: CREATED_ID },
      { index: 1, type: 'motion', id: null },
    ]);
  });

  it('compiles motion against post-layout geometry in the same plan', async () => {
    await apply([
      {
        type: 'layout',
        targets: [{ instanceId: TITLE_ID }],
        intent: { type: 'center' },
      },
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'slideIn',
        options: { direction: 'left' },
      },
    ]);

    const title = sceneDocument.components.find((c) => c.id === TITLE_ID);
    // Centered on the WORLD canvas: x = (1600 - 300) / 2 = 650.
    expect(title?.position).toEqual({ x: 650, y: 430 });
    expect(storedTracks(TITLE_ID)).toEqual([
      {
        property: 'position.x',
        keyframes: [
          { frame: 0, value: 0, easing: 'easeOut' },
          { frame: 15, value: 650, easing: 'linear' },
        ],
      },
    ]);
  });

  it('animates every member of a group scope (nested subgroups included)', async () => {
    const result = await apply([
      { type: 'motion', groupId: GROUP_ID, primitive: 'fadeIn' },
    ]);

    expect(updateInstance).toHaveBeenCalledTimes(2);
    expect(updateInstance).toHaveBeenNthCalledWith(
      1,
      {} as never,
      CARD_ID,
      USER_ID,
      expect.objectContaining({ animation: expect.any(Object) }),
    );
    expect(updateInstance).toHaveBeenNthCalledWith(
      2,
      {} as never,
      MEMBER_ID,
      USER_ID,
      expect.objectContaining({ animation: expect.any(Object) }),
    );
    expect(result.applied).toEqual([{ index: 0, type: 'motion', id: null }]);
    expect(storedTracks(CARD_ID)).toHaveLength(1);
    expect(storedTracks(MEMBER_ID)).toHaveLength(1);
  });

  it('applies sequential motion ops on different properties of one instance', async () => {
    const result = await apply([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
      },
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'move',
        options: { dx: 40 },
        timing: { start: 1, duration: 1 },
      },
    ]);

    expect(updateInstance).toHaveBeenCalledTimes(2);
    expect(result.applied).toEqual([
      { index: 0, type: 'motion', id: null },
      { index: 1, type: 'motion', id: null },
    ]);
    const properties = storedTracks(TITLE_ID).map((track) => track.property);
    expect(properties).toEqual(['style.opacity', 'position.x']);
  });

  it('applies nothing at all when a motion plan fails validation', async () => {
    const failure = await failureOf([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'sparkle' },
    ]);
    expect(failure.code).toBe('AI_OPERATION_INVALID');
    expect(failure.statusCode).toBe(422);
    expect(failure.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'MOTION_UNSUPPORTED_PRIMITIVE' })]),
    );
    expect(updateInstance).not.toHaveBeenCalled();
    expect(createInstance).not.toHaveBeenCalled();
    expect(storedTracks(TITLE_ID)).toEqual([]);
  });

  it('surfaces motion conflicts through the validation-first apply gate', async () => {
    const failure = await failureOf([
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fadeIn',
        timing: { duration: 1 },
      },
      {
        type: 'motion',
        targets: [{ instanceId: TITLE_ID }],
        primitive: 'fade',
        options: { from: 0.2, to: 0.6 },
        timing: { start: 0.5, duration: 1 },
      },
    ]);
    expect(failure.code).toBe('AI_OPERATION_INVALID');
    expect(failure.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'MOTION_CONFLICT' })]),
    );
    expect(updateInstance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Application-side verification (the model cannot self-declare success)
// ---------------------------------------------------------------------------

describe('motion verification', () => {
  const motionOp = (operations: unknown[]): ReturnType<typeof parseAIPlan> =>
    parseAIPlan({ operations });

  it('passes with no motion operations', () => {
    expect(
      verifyAppliedMotion({ document: sceneDocument, operations: [] }),
    ).toEqual({ passed: true, issues: [] });
  });

  it('passes against the document a real apply produced', async () => {
    await apply([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
    ]);
    const plan = motionOp([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
    ]);
    expect(
      verifyAppliedMotion({ document: sceneDocument, operations: plan.operations }),
    ).toEqual({ passed: true, issues: [] });
  });

  it('fails when the stored keyframes were tampered with', async () => {
    await apply([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
    ]);
    const track = storedTracks(TITLE_ID)[0];
    (track.keyframes as Array<{ frame: number; value: number }>)[1].value = 0.5;

    const plan = motionOp([
      { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
    ]);
    const outcome = verifyAppliedMotion({
      document: sceneDocument,
      operations: plan.operations,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.issues[0]).toContain('motion: ');
    expect(outcome.issues[0]).toContain('expected 1');
  });
});

// ---------------------------------------------------------------------------
// Context & prompts
// ---------------------------------------------------------------------------

describe('AI context & prompts (Stage 4D)', () => {
  it('documents the motion operation and easing vocabulary', () => {
    const context = buildAIContext({
      document: sceneDocument,
      definitions: registryRows,
      userId: USER_ID,
    });
    expect(context.version).toBe('3');
    expect(context.instructions).toContain('motion');
    expect(context.instructions).toContain('slideIn');
    expect(context.instructions).toContain('scaleEmphasis');
    expect(context.instructions).toContain('choreography');
    expect(context.instructions).toContain('easeOutBack');
    expect(context.instructions).toContain('easeInQuad');
  });

  it('keeps the agent instructions in sync', () => {
    expect(AGENT_SCENE_INSTRUCTIONS).toContain('motion');
    expect(AGENT_SCENE_INSTRUCTIONS).toContain('stagger');
    expect(AGENT_SCENE_INSTRUCTIONS).toContain('scaleEmphasis');
    expect(AGENT_SCENE_INSTRUCTIONS).toContain('MOTION_');
  });

  it('bumps the system prompt contract to v3 with the motion rule', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.version).toBe('3');
    expect(AI_CONTEXT_VERSION).toBe('3');
    expect(prompt.text).toContain('"motion"');
    expect(prompt.text).toContain('slideIn');
    expect(prompt.text).toContain('you never emit keyframes');
    expect(prompt.text).toContain('camera effects');
  });
});

// ---------------------------------------------------------------------------
// Bounded agent end-to-end
// ---------------------------------------------------------------------------

describe('agent motion end-to-end', () => {
  it('applies a motion plan in a single iteration and verifies it', async () => {
    const { provider, generate } = scriptedProvider([
      {
        plan: {
          operations: [
            { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
          ],
        },
        verification: { instances: [{ instanceId: TITLE_ID }] },
      },
    ]);

    const result = await runSceneAgent({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      prompt: 'Fade the title in at the start.',
      provider,
      definitions: registryRows,
    });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.appliedOperations).toEqual([
      { iteration: 1, index: 0, type: 'motion', id: null },
    ]);
    expect(result.verification).toEqual({ passed: true, issues: [] });
    expect(result.failure).toBeUndefined();
    expect(storedTracks(TITLE_ID)).toHaveLength(1);
    // The agent contract itself stays at "1"; only the scene context bumped.
    expect(result.meta.contextVersion).toBe('1');
  });

  it('feeds deterministic motion issues back into the bounded loop', async () => {
    const { provider, generate } = scriptedProvider([
      {
        // Iteration 1: capability-gated primitive → validation feedback.
        plan: {
          operations: [
            { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'wipeIn' },
          ],
        },
        verification: { instances: [{ instanceId: TITLE_ID }] },
      },
      {
        // Iteration 2: corrected plan applies and verifies.
        plan: {
          operations: [
            { type: 'motion', targets: [{ instanceId: TITLE_ID }], primitive: 'fadeIn' },
          ],
        },
        verification: { instances: [{ instanceId: TITLE_ID }] },
      },
    ]);

    const result = await runSceneAgent({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      prompt: 'Fade the title in.',
      provider,
      definitions: registryRows,
    });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.appliedOperations).toEqual([
      { iteration: 2, index: 0, type: 'motion', id: null },
    ]);
    expect(result.verification).toEqual({ passed: true, issues: [] });
    expect(storedTracks(TITLE_ID)).toHaveLength(1);
  });
});
