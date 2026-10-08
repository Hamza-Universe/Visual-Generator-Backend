import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SceneDocument } from '@app/schema';
import { AppError } from '../src/errors.js';
import {
  parseAIPlan,
  validateScenePlan,
  applyScenePlan,
  type AIPlanDefinition,
} from '../src/ai/apply.js';
import { buildAIContext, type AIContextInput } from '../src/ai/context.js';
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
  getSceneDocument,
  requireSceneAccess,
  updateInstance,
} from '../src/services/documents.js';

/**
 * Stage 4C — AI semantic layout integration.
 *
 * The documents service is mocked with an in-memory mutable fixture, so the
 * REAL plan → validation → engine → mutation pipeline runs end-to-end:
 * layout intents are resolved by `@app/render`'s deterministic engine and
 * written back through the existing `updateInstance` mutation mechanism.
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
const ARROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MISSING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LABEL_DEF_ID = '77777777-7777-4777-8777-777777777777';
const ARROW_DEF_ID = '88888888-8888-4888-8888-888888888888';
const GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUBGROUP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

const arrowDefinition: AIPlanDefinition = {
  id: ARROW_DEF_ID,
  name: 'Arrow',
  description: 'An arrow between two instances',
  propsSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
  },
  defaultProps: { from: '', to: '' },
  refProps: ['from', 'to'],
};

const definitions = [labelDefinition, arrowDefinition];

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
  {
    ...arrowDefinition,
    enterStyles: [],
    exitStyles: [],
    colorProps: [],
    assetProps: [],
    userId: USER_ID,
    isPublic: false,
  },
] as AIContextInput['definitions'];

/**
 * Layered fixture (document order matters):
 *   TITLE   {100,100} 300×40          Label "Title" (fontSize 24)
 *   CARD    {100,300} 220×40          Label "Card"  in group → subgroup
 *   MEMBER  {100,500} 220×40          Label "Member" in nested subgroup
 *   ARROW   {0,0}     100×100         derived geometry (from TITLE to CARD)
 */
const makeComponent = (input: {
  id: string;
  definitionId: string;
  props: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
  groupId?: string | null;
  zIndex?: number;
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
  zIndex: input.zIndex ?? 0,
  timing: { start: 0, duration: 2 },
  animation: { enter: [], exit: [], keyframes: [] },
});

const makeSceneDocument = (): SceneDocument =>
  ({
    id: SCENE_ID,
    projectId: PROJECT_ID,
    name: 'Layout scene',
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
      makeComponent({
        id: ARROW_ID,
        definitionId: ARROW_DEF_ID,
        props: { from: TITLE_ID, to: CARD_ID },
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        zIndex: 5,
      }),
    ],
    groups: [
      {
        id: GROUP_ID,
        sceneId: SCENE_ID,
        parentGroupId: null,
        name: 'Stack',
        zIndex: 0,
      },
      {
        id: SUBGROUP_ID,
        sceneId: SCENE_ID,
        parentGroupId: GROUP_ID,
        name: 'Inner',
        zIndex: 1,
      },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockState.createdCount = 0;
  sceneDocument = makeSceneDocument();
});

// ---------------------------------------------------------------------------
// Schema (plan parsing)
// ---------------------------------------------------------------------------

describe('AI layout operation schema', () => {
  it('parses layout operations with engine defaults', () => {
    const plan = parseAIPlan({
      operations: [
        {
          type: 'layout',
          targets: [{ instanceId: TITLE_ID }],
          intent: { type: 'horizontal' },
        },
      ],
    });
    expect(plan.operations[0]).toMatchObject({
      type: 'layout',
      targets: [{ instanceId: TITLE_ID }],
      constrainToCanvas: false,
      resolveCollisions: false,
      intent: { type: 'horizontal', gap: 16, justify: 'start', align: 'start' },
    });
  });

  it('rejects unknown intent types', () => {
    expect(() =>
      parseAIPlan({
        operations: [
          {
            type: 'layout',
            targets: [{ instanceId: TITLE_ID }],
            intent: { type: 'shove' },
          },
        ],
      }),
    ).toThrow(AppError);
  });

  it('accepts every scope form and container kinds', () => {
    expect(() =>
      parseAIPlan({
        operations: [{ type: 'layout', all: true, intent: { type: 'center' } }],
      }),
    ).not.toThrow();
    expect(() =>
      parseAIPlan({
        operations: [
          { type: 'layout', groupId: GROUP_ID, intent: { type: 'grid' } },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseAIPlan({
        operations: [
          {
            type: 'layout',
            targets: [{ clientKey: 'card' }],
            intent: {
              type: 'horizontal',
              container: { kind: 'group', groupId: GROUP_ID },
            },
          },
        ],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('layout plan validation', () => {
  it('accepts instance targets with a packing intent', () => {
    expect(
      validate([
        {
          type: 'layout',
          targets: [{ instanceId: TITLE_ID }, { instanceId: CARD_ID }],
          intent: { type: 'horizontal', gap: 24 },
        },
      ]),
    ).toEqual([]);
  });

  it('accepts group and all scopes', () => {
    expect(
      validate([
        { type: 'layout', groupId: GROUP_ID, intent: { type: 'vertical' } },
      ]),
    ).toEqual([]);
    expect(
      validate([{ type: 'layout', all: true, intent: { type: 'stack' } }]),
    ).toEqual([]);
  });

  it('accepts clientKey targets created earlier in the same plan', () => {
    expect(
      validate([
        {
          type: 'createInstance',
          clientKey: 'new-card',
          definitionName: 'Label',
          props: { text: 'New' },
        },
        {
          type: 'layout',
          targets: [{ instanceId: TITLE_ID }, { clientKey: 'new-card' }],
          intent: { type: 'horizontal', gap: 16 },
        },
      ]),
    ).toEqual([]);
  });

  it('accepts valid instance and group containers', () => {
    expect(
      validate([
        {
          type: 'layout',
          targets: [{ instanceId: TITLE_ID }],
          intent: {
            type: 'align',
            axis: 'x',
            mode: 'center',
            container: { kind: 'instance', instanceId: CARD_ID },
          },
        },
      ]),
    ).toEqual([]);
    expect(
      validate([
        {
          type: 'layout',
          targets: [{ instanceId: TITLE_ID }],
          intent: {
            type: 'horizontal',
            container: { kind: 'group', groupId: GROUP_ID },
          },
        },
      ]),
    ).toEqual([]);
  });

  it('rejects a layout without any scope', () => {
    const issues = validate([
      { type: 'layout', intent: { type: 'center' } },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: 'targets',
      code: 'AI_OPERATION_INVALID',
      message: 'layout requires targets, a group scope, or all=true',
    });
  });

  it('rejects unknown instance targets', () => {
    const issues = validate([
      {
        type: 'layout',
        targets: [{ instanceId: MISSING_ID }],
        intent: { type: 'horizontal' },
      },
    ]);
    expect(issues[0]).toMatchObject({
      path: 'targets.0',
      message: 'Instance does not exist in this scene',
    });
  });

  it('rejects unknown group scopes', () => {
    const issues = validate([
      { type: 'layout', groupId: MISSING_ID, intent: { type: 'grid' } },
    ]);
    expect(issues[0]).toMatchObject({
      path: 'groupId',
      message: 'Group does not exist in this scene',
    });
  });

  it('rejects containers that do not exist in the scene', () => {
    const byInstance = validate([
      {
        type: 'layout',
        targets: [{ instanceId: TITLE_ID }],
        intent: {
          type: 'horizontal',
          container: { kind: 'instance', instanceId: MISSING_ID },
        },
      },
    ]);
    expect(byInstance[0]).toMatchObject({
      path: 'intent.container',
      message: 'Layout container instance does not exist in this scene',
    });

    const byGroup = validate([
      {
        type: 'layout',
        targets: [{ instanceId: TITLE_ID }],
        intent: {
          type: 'horizontal',
          container: { kind: 'group', groupClientKey: 'g1' },
        },
      },
    ]);
    expect(byGroup[0]).toMatchObject({
      path: 'intent.container',
      message: 'Layout container group does not exist in this scene',
    });
  });
});

// ---------------------------------------------------------------------------
// Application (validation → engine → document mutations)
// ---------------------------------------------------------------------------

describe('layout plan application', () => {
  it('packs targets and re-anchors the connector through updateInstance', async () => {
    const result = await apply([
      {
        type: 'layout',
        targets: [{ instanceId: TITLE_ID }, { instanceId: CARD_ID }],
        intent: { type: 'horizontal', gap: 24 },
      },
    ]);

    // TITLE already sits at the union origin; CARD moves; the arrow becomes
    // the segment box between the two final boxes.
    expect(updateInstance).toHaveBeenCalledTimes(2);
    expect(updateInstance).toHaveBeenNthCalledWith(
      1,
      {} as never,
      CARD_ID,
      USER_ID,
      { position: { x: 424, y: 100 } },
    );
    expect(updateInstance).toHaveBeenNthCalledWith(
      2,
      {} as never,
      ARROW_ID,
      USER_ID,
      { position: { x: 400, y: 120 }, size: { width: 24, height: 1 } },
    );
    expect(result.applied).toEqual([{ index: 0, type: 'layout', id: null }]);
    expect(
      result.document.components.find((c) => c.id === CARD_ID)?.position,
    ).toEqual({ x: 424, y: 100 });
    expect(
      result.document.components.find((c) => c.id === ARROW_ID)?.position,
    ).toEqual({ x: 400, y: 120 });
    expect(
      result.document.components.find((c) => c.id === ARROW_ID)?.size,
    ).toEqual({ width: 24, height: 1 });
  });

  it('lays out a group scope including nested subgroup members', async () => {
    const result = await apply([
      {
        type: 'layout',
        groupId: GROUP_ID,
        intent: { type: 'vertical', gap: 10 },
      },
    ]);

    // Group members: CARD (direct) + MEMBER (nested subgroup). CARD is already
    // at the union origin; MEMBER stacks under it.
    expect(updateInstance).toHaveBeenCalledTimes(2);
    expect(updateInstance).toHaveBeenNthCalledWith(
      1,
      {} as never,
      MEMBER_ID,
      USER_ID,
      { position: { x: 100, y: 350 } },
    );
    expect(updateInstance).toHaveBeenNthCalledWith(
      2,
      {} as never,
      ARROW_ID,
      USER_ID,
      { position: { x: 214, y: 140 }, size: { width: 32, height: 160 } },
    );
    expect(result.applied).toEqual([{ index: 0, type: 'layout', id: null }]);
    expect(
      result.document.components.find((c) => c.id === MEMBER_ID)?.position,
    ).toEqual({ x: 100, y: 350 });
  });

  it('applies text-aware sizing through the same mutation path', async () => {
    const result = await apply([
      {
        type: 'layout',
        targets: [{ instanceId: TITLE_ID }],
        intent: { type: 'fitText' },
      },
    ]);

    // "Title" × 24px → 5 × 14.4 = 72 wide, 30 tall; position unchanged.
    expect(updateInstance).toHaveBeenCalledTimes(2);
    expect(updateInstance).toHaveBeenNthCalledWith(
      1,
      {} as never,
      TITLE_ID,
      USER_ID,
      { position: { x: 100, y: 100 }, size: { width: 72, height: 30 } },
    );
    expect(
      result.document.components.find((c) => c.id === TITLE_ID)?.size,
    ).toEqual({ width: 72, height: 30 });
  });

  it('constrains the whole scene while leaving already-inside geometry alone', async () => {
    const result = await apply([
      { type: 'layout', all: true, intent: { type: 'constrain' } },
    ]);

    // Everything is inside the WORLD canvas → only the connector is rewritten
    // to its (already valid) derived segment box.
    expect(updateInstance).toHaveBeenCalledTimes(1);
    expect(updateInstance).toHaveBeenNthCalledWith(
      1,
      {} as never,
      ARROW_ID,
      USER_ID,
      { position: { x: 214, y: 140 }, size: { width: 32, height: 160 } },
    );
    expect(result.applied).toEqual([{ index: 0, type: 'layout', id: null }]);
  });

  it('applies nothing at all when validation fails', async () => {
    await expect(
      apply([
        {
          type: 'layout',
          targets: [{ instanceId: MISSING_ID }],
          intent: { type: 'horizontal' },
        },
      ]),
    ).rejects.toMatchObject({
      code: 'AI_OPERATION_INVALID',
      statusCode: 422,
    });
    expect(updateInstance).not.toHaveBeenCalled();
    expect(createInstance).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Context & prompts
// ---------------------------------------------------------------------------

describe('AI context & prompts (Stage 4C)', () => {
  it('documents the layout operation in the context instructions', () => {
    const context = buildAIContext({
      document: sceneDocument,
      definitions: registryRows,
      userId: USER_ID,
    });
    expect(context.version).toBe('3');
    expect(context.instructions).toContain('layout');
    expect(context.instructions).toContain('style.layoutOverlap');
    expect(context.instructions).toContain('moveInstance');
    expect(context.instructions).toContain('distribute');
  });

  it('keeps the agent instructions in sync', () => {
    const text = AGENT_SCENE_INSTRUCTIONS;
    expect(text).toContain('layout');
    expect(text).toContain('intentional');
    expect(text).toContain('resolveCollisions');
  });

  it('bumps the system prompt contract to v3 with the layout rule', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.version).toBe('3');
    expect(AI_CONTEXT_VERSION).toBe('3');
    expect(prompt.text).toContain('"layout"');
    expect(prompt.text).toContain('style.layoutOverlap');
  });
});

// ---------------------------------------------------------------------------
// Bounded agent end-to-end
// ---------------------------------------------------------------------------

describe('agent layout end-to-end', () => {
  it('applies a semantic layout plan in a single iteration', async () => {
    const { provider, generate } = scriptedProvider([
      {
        plan: {
          operations: [
            {
              type: 'layout',
              targets: [{ instanceId: TITLE_ID }, { instanceId: CARD_ID }],
              intent: { type: 'horizontal', gap: 24 },
            },
          ],
        },
        verification: {
          instances: [
            { instanceId: TITLE_ID, expectPosition: { x: 100, y: 100 } },
            { instanceId: CARD_ID, expectPosition: { x: 424, y: 100 } },
          ],
        },
      },
    ]);

    const result = await runSceneAgent({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      prompt: 'Put the title and the card in a row.',
      provider,
      definitions: registryRows,
    });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.appliedOperations).toEqual([
      { iteration: 1, index: 0, type: 'layout', id: null },
    ]);
    expect(result.verification).toEqual({ passed: true, issues: [] });
    expect(result.failure).toBeUndefined();
    // The mutation actually landed in the scene document.
    expect(
      sceneDocument.components.find((c) => c.id === CARD_ID)?.position,
    ).toEqual({ x: 424, y: 100 });
    expect(
      sceneDocument.components.find((c) => c.id === ARROW_ID)?.position,
    ).toEqual({ x: 400, y: 120 });
    // The bounded-agent contract itself is unchanged (Stage 4B stays at "1").
    expect(result.meta.contextVersion).toBe('1');
  });
});
