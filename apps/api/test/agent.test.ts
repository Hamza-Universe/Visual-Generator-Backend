import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SceneDocument } from '@app/schema';
import { AppError } from '../src/errors.js';
import {
  AIAgentTurnSchema,
  buildAgentUserMessage,
  resolveAgentLimits,
  runSceneAgent,
  MAX_CONTEXT_OBSERVATIONS,
} from '../src/ai/agent.js';
import {
  AIAgentVerificationSchema,
  verifySceneExpectations,
} from '../src/ai/verification.js';
import {
  AGENT_TOOL_NAMES,
  executeAgentTool,
  findSceneOverlaps,
  getInstance,
} from '../src/ai/tools.js';
import type { AIPlanDefinition } from '../src/ai/apply.js';
import type { AIContextInput } from '../src/ai/context.js';
import type {
  AISceneProvider,
  AIStructuredRequest,
  AIStructuredResult,
} from '../src/ai/provider.js';
import {
  createInstance,
  getSceneDocument,
  requireSceneAccess,
  updateInstance,
} from '../src/services/documents.js';

/**
 * Stage 4B bounded agentic editing — mocked provider only, no OpenRouter.
 *
 * The documents service is mocked with an in-memory mutable fixture so the
 * REAL harness (turn schema, tools, validation, apply path, verification)
 * runs end-to-end across iterations: the second iteration genuinely sees
 * the state the first one wrote.
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
        position: (raw.position as { x: number; y: number } | undefined) ?? { x: 0, y: 0 },
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
const EQUATION_ID = '66666666-6666-4666-8666-666666666666';
const ARROW_ID = '99999999-9999-4999-8999-999999999999';
const LABEL_DEF_ID = '77777777-7777-4777-8777-777777777777';
const ARROW_DEF_ID = '88888888-8888-4888-8888-888888888888';
const SECRET_DEF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIRST_CREATED_ID = '00000000-0000-4000-8000-000000000000';

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
    properties: { from: { type: 'string' }, to: { type: 'string' }, color: { type: 'string' } },
  },
  defaultProps: { from: '', to: '', color: '#000000' },
  refProps: ['from', 'to'],
};

/** Authorized registry rows (public Label + own Arrow); Secret is absent. */
const registryRows: AIContextInput['definitions'] = [
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
];

const definitions: AIPlanDefinition[] = [labelDefinition, arrowDefinition];

const makeComponent = (input: {
  id: string;
  definitionId: string;
  props: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
}) => ({
  id: input.id,
  sceneId: SCENE_ID,
  componentDefinitionId: input.definitionId,
  groupId: null,
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
 * Deterministic overlap scene:
 *   Title     x=100 y=100 300×40  (bottom edge y=140)
 *   Equation  x=100 y=120 220×48  (overlaps the title)
 *   Arrow     x=0   y=0   100×100 (touches neither)
 */
const makeSceneDocument = (): SceneDocument =>
  ({
    id: SCENE_ID,
    projectId: PROJECT_ID,
    name: 'Overlap scene',
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
        id: EQUATION_ID,
        definitionId: LABEL_DEF_ID,
        props: { text: 'F = ma', fontSize: 24 },
        position: { x: 100, y: 120 },
        size: { width: 220, height: 48 },
      }),
      makeComponent({
        id: ARROW_ID,
        definitionId: ARROW_DEF_ID,
        props: { from: TITLE_ID, to: EQUATION_ID, color: '#000000' },
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
      }),
    ],
    groups: [],
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
    provider: {
      provider: 'openrouter',
      model: 'test-model',
      generateStructured: generate,
    } as unknown as AISceneProvider,
    generate,
    requests,
  };
};

const runAgent = (
  provider: AISceneProvider,
  overrides: Partial<Parameters<typeof runSceneAgent>[0]> = {},
) =>
  runSceneAgent({
    db: {} as never,
    sceneId: SCENE_ID,
    userId: USER_ID,
    prompt: 'Move the equation below the title without overlapping it.',
    provider,
    definitions: registryRows,
    ...overrides,
  });

const movePlan = (instanceId: string, x: number, y: number) => ({
  operations: [{ type: 'moveInstance', instanceId, position: { x, y } }],
});

const overlapVerification = {
  instances: [{ instanceId: TITLE_ID }, { instanceId: EQUATION_ID }],
  noOverlap: true,
  noOverlapWithScene: true,
};

const titleAt500 = {
  instances: [{ instanceId: TITLE_ID, expectPosition: { x: 500, y: 100 } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState.createdCount = 0;
  sceneDocument = makeSceneDocument();
});

// ---------------------------------------------------------------------------
// §45 / Case A — one-shot success
// ---------------------------------------------------------------------------

describe('Bounded agent — single-iteration completion', () => {
  it('completes a simple move in exactly one iteration without re-calling the model', async () => {
    const { provider, generate, requests } = scriptedProvider([
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider, { prompt: 'Move the title to x=500.' });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    expect(result.modelCalls).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toBe(0);
    expect(result.appliedOperations).toEqual([
      { iteration: 1, index: 0, type: 'moveInstance', id: TITLE_ID },
    ]);
    expect(result.verification).toEqual({ passed: true, issues: [] });
    expect(result.failure).toBeUndefined();
    expect(sceneDocument.components.find((c) => c.id === TITLE_ID)?.position).toEqual({
      x: 500,
      y: 100,
    });
    expect(result.meta).toMatchObject({
      provider: 'openrouter',
      model: 'test-model',
      contextVersion: '1',
    });
    expect(result.meta.usage?.totalTokens).toBe(15);
    expect(requests[0].user).toContain('Move the title to x=500.');
  });

  it('completes a done-only decision when verification already holds', async () => {
    const { provider, generate } = scriptedProvider([
      {
        done: true,
        verification: {
          instances: [{ instanceId: TITLE_ID, expectPosition: { x: 100, y: 100 } }],
        },
      },
    ]);
    const result = await runAgent(provider, { prompt: 'Nothing to change.' });
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.appliedOperations).toHaveLength(0);
    expect(result.plans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §44 / Case B — the critical iterative-correction scenario
// ---------------------------------------------------------------------------

describe('Bounded agent — inspect → apply → re-inspect → correct', () => {
  it('detects a remaining overlap after an insufficient move and corrects it in iteration 2', async () => {
    const { provider, generate, requests } = scriptedProvider([
      // Iteration 1, turn 1: inspect first (targeted reads, not the whole doc).
      { toolCalls: [{ name: 'findOverlaps', args: { instanceIds: [TITLE_ID, EQUATION_ID] } }] },
      // Iteration 1, turn 2: an INSUFFICIENT move (y=130 still overlaps y<140).
      { plan: movePlan(EQUATION_ID, 100, 130), verification: overlapVerification },
      // Iteration 2, turn 1: inspect the result.
      { toolCalls: [{ name: 'getInstanceBounds', args: { instanceId: EQUATION_ID } }] },
      // Iteration 2, turn 2: the correction.
      { plan: movePlan(EQUATION_ID, 100, 160), verification: overlapVerification },
    ]);

    const result = await runAgent(provider);

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.modelCalls).toBe(4);
    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.plans).toHaveLength(2);
    expect(result.appliedOperations).toEqual([
      { iteration: 1, index: 0, type: 'moveInstance', id: EQUATION_ID },
      { iteration: 2, index: 0, type: 'moveInstance', id: EQUATION_ID },
    ]);
    // The application state — not the model's claim — decides success.
    expect(sceneDocument.components.find((c) => c.id === EQUATION_ID)?.position).toEqual({
      x: 100,
      y: 160,
    });
    expect(result.verification).toEqual({ passed: true, issues: [] });
    expect(result.meta.usage?.totalTokens).toBe(60);

    // Turn 2 of iteration 1 received the first inspection result.
    expect(requests[1].user).toContain('"pairs"');
    expect(requests[1].user).toContain(TITLE_ID);
    // Iteration 2 opens with the FAILED verification feedback from iteration 1.
    expect(requests[2].user).toContain('overlap');
    expect(requests[2].user).toContain('"kind":"verification"');
    // Iteration 2 also sees the bounds observation before deciding.
    expect(requests[3].user).toContain('"x":100');
  });

  it('reports every applied operation and plan as bounded execution metadata', async () => {
    const { provider } = scriptedProvider([
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].operations).toHaveLength(1);
    expect(result.iterations).toBe(1);
    expect(result.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// §46 / Case D — termination at the iteration limit
// ---------------------------------------------------------------------------

describe('Bounded agent — termination and budgets', () => {
  it('stops at max_iterations when corrections keep failing verification (no infinite loop)', async () => {
    const { provider, generate } = scriptedProvider([
      { plan: movePlan(EQUATION_ID, 100, 130), verification: overlapVerification },
    ]);
    const result = await runAgent(provider);

    expect(result.status).toBe('max_iterations');
    expect(result.iterations).toBe(3);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.appliedOperations).toHaveLength(3);
    expect(result.verification?.passed).toBe(false);
    expect(result.failure).toBeUndefined();
  });

  it('ends with validation_failed when every plan is invalid and never mutates the scene', async () => {
    const { provider, generate } = scriptedProvider([
      {
        plan: { operations: [{ type: 'moveInstance', instanceId: MISSING_ID, position: { x: 0, y: 0 } }] },
        verification: { instances: [{ instanceId: MISSING_ID }] },
      },
    ]);
    const before = JSON.stringify(sceneDocument);
    const result = await runAgent(provider);

    expect(result.status).toBe('validation_failed');
    expect(result.iterations).toBe(3);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(updateInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(sceneDocument)).toBe(before);
    // Rejected plans are still reported, and feedback reached the model.
    expect(result.plans).toHaveLength(3);
    expect(result.appliedOperations).toHaveLength(0);
  });

  it('enforces the request-level operation budget across iterations', async () => {
    const { provider, requests } = scriptedProvider([
      {
        plan: {
          operations: [
            { type: 'moveInstance', instanceId: TITLE_ID, position: { x: 500, y: 100 } },
            { type: 'moveInstance', instanceId: EQUATION_ID, position: { x: 100, y: 160 } },
          ],
        },
        // Deliberately unmet (equation is at x=100, not x=150) so iteration 2 runs.
        verification: {
          instances: [{ instanceId: EQUATION_ID, expectPosition: { x: 150, y: 160 } }],
        },
      },
      // Would need 3rd operation: the budget (2) must block it.
      { plan: movePlan(EQUATION_ID, 150, 160), verification: titleAt500 },
      { done: true, verification: titleAt500 },
    ]);
    const result = await runAgent(provider, { limits: { operationBudget: 2 } });

    expect(result.status).toBe('completed');
    expect(result.appliedOperations).toHaveLength(2);
    expect(updateInstance).toHaveBeenCalledTimes(2);
    expect(requests[2].user).toContain('Operation budget');
  });

  it('enforces the tool call budget and terminates with tool_error', async () => {
    const { provider, generate } = scriptedProvider([
      {
        toolCalls: [
          { name: 'getScene', args: {} },
          { name: 'getScene', args: {} },
        ],
      },
    ]);
    const result = await runAgent(provider, {
      limits: { toolCallBudget: 3, turnsPerIteration: 8 },
    });

    expect(result.status).toBe('tool_error');
    expect(result.failure?.code).toBe('AI_TOOL_BUDGET_EXCEEDED');
    expect(result.toolCalls).toBe(3);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(updateInstance).not.toHaveBeenCalled();
  });

  it('stops after too many failed tool calls instead of looping', async () => {
    const { provider, generate } = scriptedProvider([
      { toolCalls: [{ name: 'dropDatabase', args: {} }] },
    ]);
    const result = await runAgent(provider, { limits: { toolErrorBudget: 2 } });

    expect(result.status).toBe('tool_error');
    expect(result.failure?.code).toBe('AI_TOOL_ERROR');
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('fails fast with timeout before any model call', async () => {
    const { provider, generate } = scriptedProvider([
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider, { limits: { timeoutMs: 0 } });

    expect(result.status).toBe('timeout');
    expect(generate).not.toHaveBeenCalled();
    expect(result.iterations).toBe(1);
    expect(updateInstance).not.toHaveBeenCalled();
  });

  it('bounds schema-invalid responses with feedback, then fails cleanly', async () => {
    // Every response is an empty object: no tools, no plan, no verification.
    const { provider, generate, requests } = scriptedProvider([{}]);
    const result = await runAgent(provider);

    expect(result.status).toBe('validation_failed');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.failure?.code).toBe('AI_SCHEMA_ERROR');
    expect(updateInstance).not.toHaveBeenCalled();
    // The bounded retry carried the exact contract violation back to the model.
    expect(requests[1].user).toContain('verification is required');
  });

  it('recovers from a single schema-invalid response via bounded feedback', async () => {
    const { provider, requests } = scriptedProvider([
      {}, // invalid first attempt
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider);
    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[1].user).toContain('verification is required');
  });
});

// ---------------------------------------------------------------------------
// Cases C, E, F — invalid target, authorization, provider failure
// ---------------------------------------------------------------------------

describe('Bounded agent — failures and safety', () => {
  it('handles provider failure safely without touching the scene or retrying', async () => {
    const generate = vi.fn(async () => {
      throw new AppError('AI_PROVIDER_ERROR', 'AI provider returned HTTP 502', 502);
    });
    const provider = {
      provider: 'openrouter',
      model: 'test-model',
      generateStructured: generate,
    } as unknown as AISceneProvider;
    const before = JSON.stringify(sceneDocument);

    const result = await runAgent(provider);

    expect(result.status).toBe('provider_error');
    expect(result.failure).toMatchObject({ code: 'AI_PROVIDER_ERROR' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(updateInstance).not.toHaveBeenCalled();
    expect(JSON.stringify(sceneDocument)).toBe(before);
    expect(result.failure?.message).not.toContain('at Object');
  });

  it('rejects an unauthorized scene before any model call', async () => {
    vi.mocked(getSceneDocument).mockRejectedValueOnce(
      new AppError('FORBIDDEN', 'Scene is not accessible', 403),
    );
    const { provider, generate } = scriptedProvider([
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);

    await expect(runAgent(provider)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(updateInstance).not.toHaveBeenCalled();
  });

  it('rejects a plan referencing a private/unauthorized definition with zero writes', async () => {
    const { provider } = scriptedProvider([
      {
        plan: {
          operations: [
            { type: 'createInstance', clientKey: 'x', definitionName: 'Secret' },
          ],
        },
        verification: { instances: [{ clientKey: 'x' }] },
      },
    ]);
    const result = await runAgent(provider, {
      definitions: [labelDefinition] as never,
      limits: { maxIterations: 1 },
    });

    expect(result.status).toBe('validation_failed');
    expect(createInstance).not.toHaveBeenCalled();
    expect(result.failure?.code).toBeUndefined();
  });

  it('rejects invalid references at validation time with zero writes', async () => {
    const { provider } = scriptedProvider([
      {
        plan: {
          operations: [
            {
              type: 'setReference',
              instanceId: ARROW_ID,
              prop: 'from',
              targetInstanceId: MISSING_ID,
            },
          ],
        },
        verification: { instances: [{ instanceId: ARROW_ID }] },
      },
    ]);
    const result = await runAgent(provider, { limits: { maxIterations: 1 } });

    expect(result.status).toBe('validation_failed');
    expect(updateInstance).not.toHaveBeenCalled();
  });

  it('stops with unauthorized when authorization fails at apply time', async () => {
    vi.mocked(requireSceneAccess).mockRejectedValueOnce(
      new AppError('FORBIDDEN', 'Scene is not accessible', 403),
    );
    const { provider } = scriptedProvider([
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider);

    expect(result.status).toBe('unauthorized');
    expect(result.failure?.code).toBe('FORBIDDEN');
    expect(updateInstance).not.toHaveBeenCalled();
    expect(result.iterations).toBe(1);
  });

  it('stops with application_error after an ambiguous runtime failure and never retries the write', async () => {
    vi.mocked(updateInstance).mockRejectedValueOnce(new Error('connection reset'));
    const { provider, generate } = scriptedProvider([
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider);

    expect(result.status).toBe('application_error');
    expect(result.failure).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(updateInstance).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(1);
  });

  it('feeds unknown tool names back as safe observations, then proceeds', async () => {
    const { provider, requests } = scriptedProvider([
      { toolCalls: [{ name: 'execShell', args: { cmd: 'rm -rf /' } }] },
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider);

    expect(result.status).toBe('completed');
    expect(result.toolCalls).toBe(1);
    expect(requests[1].user).toContain('Unknown tool');
    expect(requests[1].user).toContain('Allowed tools');
    expect(sceneDocument.components.find((c) => c.id === TITLE_ID)?.position).toEqual({
      x: 500,
      y: 100,
    });
  });

  it('rejects malformed tool arguments without crashing the loop', async () => {
    const { provider, requests } = scriptedProvider([
      { toolCalls: [{ name: 'getInstanceBounds', args: { instanceId: 'DROP TABLE' } }] },
      { plan: movePlan(TITLE_ID, 500, 100), verification: titleAt500 },
    ]);
    const result = await runAgent(provider);

    expect(result.status).toBe('completed');
    expect(requests[1].user).toContain('Invalid arguments for getInstanceBounds');
  });
});

// ---------------------------------------------------------------------------
// §21 — idempotency across bounded retries
// ---------------------------------------------------------------------------

describe('Bounded agent — idempotency', () => {
  it('never re-creates an object whose clientKey was already used in this request', async () => {
    const { provider, requests } = scriptedProvider([
      {
        plan: {
          operations: [
            {
              type: 'createInstance',
              clientKey: 'title',
              definitionName: 'Label',
              props: { text: 'Title' },
              position: { x: 100, y: 60 },
            },
          ],
        },
        // Deliberately unmet expectation forces iteration 2.
        verification: {
          instances: [{ clientKey: 'title', expectPosition: { x: 999 } }],
        },
      },
      {
        // The model blindly retries the create — it must be rejected.
        plan: {
          operations: [
            {
              type: 'createInstance',
              clientKey: 'title',
              definitionName: 'Label',
              props: { text: 'Duplicate' },
            },
          ],
        },
        verification: { instances: [{ clientKey: 'title' }] },
      },
      { done: true, verification: { instances: [{ instanceId: FIRST_CREATED_ID }] } },
    ]);

    const result = await runAgent(provider);

    expect(result.status).toBe('completed');
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(3);
    expect(sceneDocument.components).toHaveLength(4);
    // The retry context showed the created object, and the rejection explained why.
    expect(requests[1].user).toContain(FIRST_CREATED_ID);
    expect(requests[1].user).toContain('createdThisRequest');
    expect(requests[2].user).toContain('already created in this request');
    expect(result.appliedOperations).toEqual([
      { iteration: 1, index: 0, type: 'createInstance', id: FIRST_CREATED_ID },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

describe('Agent tool registry', () => {
  it('exposes exactly the allowlisted read tools', () => {
    expect(AGENT_TOOL_NAMES).toEqual([
      'getScene',
      'findInstances',
      'getInstance',
      'getInstanceBounds',
      'findOverlaps',
    ]);
  });

  it('rejects unknown, hostile, or code-adjacent tool names', () => {
    for (const name of [
      'eval',
      'exec',
      'constructor',
      '__proto__',
      'writeFile',
      'rawQuery',
      'fetch',
    ]) {
      const outcome = executeAgentTool({ name, args: {}, document: sceneDocument });
      expect(outcome.ok, name).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('UNKNOWN_TOOL');
    }
  });

  it('validates tool arguments before touching the snapshot', () => {
    const badId = executeAgentTool({
      name: 'getInstanceBounds',
      args: { instanceId: 'DROP TABLE components' },
      document: sceneDocument,
    });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.code).toBe('INVALID_ARGUMENTS');

    const emptyQuery = executeAgentTool({
      name: 'findInstances',
      args: { query: '' },
      document: sceneDocument,
    });
    expect(emptyQuery.ok).toBe(false);

    const nonObjectArgs = executeAgentTool({
      name: 'getInstance',
      args: ['injected'],
      document: sceneDocument,
    });
    expect(nonObjectArgs.ok).toBe(false);
    if (!nonObjectArgs.ok) expect(nonObjectArgs.code).toBe('INVALID_ARGUMENTS');
  });

  it('reads scene, instances, bounds, and overlaps through the tools', () => {
    const scene = executeAgentTool({ name: 'getScene', args: {}, document: sceneDocument });
    expect(scene.ok).toBe(true);
    if (scene.ok) expect(scene.result).toMatchObject({ instanceCount: 3, groupCount: 0 });

    const found = executeAgentTool({
      name: 'findInstances',
      args: { query: 'F = ma' },
      document: sceneDocument,
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.result).toMatchObject({ totalMatches: 1, truncated: false });
      expect((found.result as { items: Array<{ id: string }> }).items[0].id).toBe(
        EQUATION_ID,
      );
    }

    const detail = getInstance(sceneDocument, TITLE_ID);
    expect(detail).toMatchObject({ id: TITLE_ID, label: 'Title', visible: true });

    const bounds = executeAgentTool({
      name: 'getInstanceBounds',
      args: { instanceId: EQUATION_ID },
      document: sceneDocument,
    });
    expect(bounds.ok && bounds.result).toEqual({ x: 100, y: 120, width: 220, height: 48 });

    const missing = executeAgentTool({
      name: 'getInstanceBounds',
      args: { instanceId: MISSING_ID },
      document: sceneDocument,
    });
    expect(missing.ok && missing.result).toBeNull();

    const overlaps = executeAgentTool({
      name: 'findOverlaps',
      args: { instanceIds: [TITLE_ID, EQUATION_ID], againstScene: true },
      document: sceneDocument,
    });
    expect(overlaps.ok && (overlaps.result as { pairs: unknown[] }).pairs).toHaveLength(1);
  });

  it('flags truncated results instead of silently truncating', () => {
    const components = Array.from({ length: 25 }, (_, index) =>
      makeComponent({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`,
        definitionId: LABEL_DEF_ID,
        props: { text: `Match ${index}` },
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      }),
    ) as unknown as SceneDocument['components'];
    const crowded: SceneDocument = { ...sceneDocument, components };

    const outcome = executeAgentTool({
      name: 'findInstances',
      args: { query: 'Match' },
      document: crowded,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const result = outcome.result as {
        items: unknown[];
        totalMatches: number;
        truncated: boolean;
      };
      expect(result.items).toHaveLength(20);
      expect(result.totalMatches).toBe(25);
      expect(result.truncated).toBe(true);
    }
  });

  it('caps oversized serialized results with an explicit note', () => {
    const longLabel = 'x'.repeat(400);
    const components = Array.from({ length: 20 }, (_, index) =>
      makeComponent({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`,
        definitionId: LABEL_DEF_ID,
        props: { text: `${longLabel}${index}` },
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      }),
    ) as unknown as SceneDocument['components'];
    const crowded: SceneDocument = { ...sceneDocument, components };

    const outcome = executeAgentTool({
      name: 'findInstances',
      args: { query: 'x' },
      document: crowded,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const result = outcome.result as { truncated?: boolean; note?: string };
      expect(result.truncated).toBe(true);
      expect(result.note).toContain('exceeded');
    }
  });

  it('never mutates the document snapshot', () => {
    const before = JSON.stringify(sceneDocument);
    executeAgentTool({ name: 'getScene', args: {}, document: sceneDocument });
    executeAgentTool({ name: 'findInstances', args: { query: 'F' }, document: sceneDocument });
    executeAgentTool({
      name: 'getInstance',
      args: { instanceId: TITLE_ID },
      document: sceneDocument,
    });
    executeAgentTool({
      name: 'getInstanceBounds',
      args: { instanceId: EQUATION_ID },
      document: sceneDocument,
    });
    executeAgentTool({
      name: 'findOverlaps',
      args: { instanceIds: [TITLE_ID, EQUATION_ID], againstScene: true },
      document: sceneDocument,
    });
    findSceneOverlaps(sceneDocument, [TITLE_ID, EQUATION_ID]);
    getInstance(sceneDocument, MISSING_ID);
    expect(JSON.stringify(sceneDocument)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Deterministic verification
// ---------------------------------------------------------------------------

describe('Agent verification', () => {
  const parse = (value: unknown) => AIAgentVerificationSchema.parse(value);

  it('detects the initial overlap and passes after separation', () => {
    const expectations = parse(overlapVerification);
    const failing = verifySceneExpectations({
      document: sceneDocument,
      expectations,
    });
    expect(failing.passed).toBe(false);
    expect(failing.issues.join(' ')).toMatch(/overlap/i);

    const separated: SceneDocument = {
      ...sceneDocument,
      components: sceneDocument.components.map((c) =>
        c.id === EQUATION_ID ? { ...c, position: { x: 100, y: 160 } } : c,
      ),
    };
    const passing = verifySceneExpectations({ document: separated, expectations });
    expect(passing).toEqual({ passed: true, issues: [] });
  });

  it('checks existence, position, and size with a 1px tolerance', () => {
    const exact = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({
        instances: [
          { instanceId: TITLE_ID, expectPosition: { x: 100, y: 100 }, expectSize: { width: 300, height: 40 } },
        ],
      }),
    });
    expect(exact.passed).toBe(true);

    const near = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({
        instances: [{ instanceId: TITLE_ID, expectPosition: { x: 100.5 } }],
      }),
    });
    expect(near.passed).toBe(true);

    const off = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({
        instances: [{ instanceId: TITLE_ID, expectPosition: { x: 500 }, expectSize: { width: 999 } }],
      }),
    });
    expect(off.passed).toBe(false);
    expect(off.issues).toHaveLength(2);

    const gone = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({ instances: [{ instanceId: MISSING_ID }] }),
    });
    expect(gone.passed).toBe(false);
    expect(gone.issues[0]).toContain('does not exist');
  });

  it('evaluates required overlaps in both directions', () => {
    const expectations = parse({
      instances: [],
      overlapPairs: [{ a: { instanceId: TITLE_ID }, b: { instanceId: EQUATION_ID } }],
    });
    expect(verifySceneExpectations({ document: sceneDocument, expectations }).passed).toBe(
      true,
    );
    const separated: SceneDocument = {
      ...sceneDocument,
      components: sceneDocument.components.map((c) =>
        c.id === EQUATION_ID ? { ...c, position: { x: 100, y: 160 } } : c,
      ),
    };
    const broken = verifySceneExpectations({ document: separated, expectations });
    expect(broken.passed).toBe(false);
    expect(broken.issues[0]).toContain('expected to overlap');
  });

  it('verifies reference props against real instances', () => {
    const good = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({
        instances: [],
        references: [{ instanceId: ARROW_ID, props: ['from', 'to'] }],
      }),
    });
    expect(good).toEqual({ passed: true, issues: [] });

    const broken: SceneDocument = {
      ...sceneDocument,
      components: sceneDocument.components.map((c) =>
        c.id === ARROW_ID
          ? { ...c, props: { ...c.props, to: MISSING_ID } }
          : c,
      ),
    };
    const dangling = verifySceneExpectations({
      document: broken,
      expectations: parse({
        instances: [],
        references: [{ instanceId: ARROW_ID, props: ['to'] }],
      }),
    });
    expect(dangling.passed).toBe(false);
    expect(dangling.issues[0]).toContain('missing instance');
  });

  it('resolves clientKeys through the request-scoped map', () => {
    const clientKeyMap = new Map([[ 'title', TITLE_ID ]]);
    const resolved = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({ instances: [{ clientKey: 'title' }] }),
      clientKeyMap,
    });
    expect(resolved.passed).toBe(true);

    const unresolved = verifySceneExpectations({
      document: sceneDocument,
      expectations: parse({ instances: [{ clientKey: 'nope' }] }),
      clientKeyMap,
    });
    expect(unresolved.passed).toBe(false);
    expect(unresolved.issues[0]).toContain('could not be resolved');
  });

  it('requires at least one check and rejects malformed expectations', () => {
    expect(AIAgentVerificationSchema.safeParse({}).success).toBe(false);
    expect(
      AIAgentVerificationSchema.safeParse({
        instances: [{ instanceId: 'not-a-uuid' }],
      }).success,
    ).toBe(false);
    expect(
      AIAgentVerificationSchema.safeParse({ instances: [{ instanceId: TITLE_ID }] })
        .success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Turn contract, limits, context safety
// ---------------------------------------------------------------------------

describe('Agent turn schema and limits', () => {
  it('requires every non-inspection response to carry verification', () => {
    expect(AIAgentTurnSchema.safeParse({}).success).toBe(false);
    expect(
      AIAgentTurnSchema.safeParse({ toolCalls: [{ name: 'getScene' }] }).success,
    ).toBe(true);
    expect(
      AIAgentTurnSchema.safeParse({ plan: movePlan(TITLE_ID, 1, 1) }).success,
    ).toBe(false);
    expect(
      AIAgentTurnSchema.safeParse({
        plan: movePlan(TITLE_ID, 1, 1),
        verification: { instances: [{ instanceId: TITLE_ID }] },
      }).success,
    ).toBe(true);
    expect(
      AIAgentTurnSchema.safeParse({ done: true, verification: { instances: [{ instanceId: TITLE_ID }] } })
        .success,
    ).toBe(true);
    expect(
      AIAgentTurnSchema.safeParse({ done: true }).success,
    ).toBe(false);
  });

  it('caps tool calls in a single response', () => {
    const many = {
      toolCalls: Array.from({ length: 7 }, () => ({ name: 'getScene', args: {} })),
    };
    expect(AIAgentTurnSchema.safeParse(many).success).toBe(false);
    const six = {
      toolCalls: Array.from({ length: 6 }, () => ({ name: 'getScene', args: {} })),
    };
    expect(AIAgentTurnSchema.safeParse(six).success).toBe(true);
  });

  it('keeps every limit application-owned and clamped', () => {
    const defaults = resolveAgentLimits();
    expect(defaults).toMatchObject({
      maxIterations: 3,
      toolCallBudget: 16,
      operationBudget: 100,
      timeoutMs: 60_000,
    });
    expect(resolveAgentLimits({ maxIterations: 99 }).maxIterations).toBe(5);
    expect(resolveAgentLimits({ maxIterations: -3 }).maxIterations).toBe(1);
    expect(resolveAgentLimits({ toolCallBudget: 10_000 }).toolCallBudget).toBe(64);
    expect(resolveAgentLimits({ timeoutMs: 0 }).timeoutMs).toBe(0);
  });
});

describe('Agent context', () => {
  it('carries budgets, tools, observations, feedback, and created objects — never internals', () => {
    const message = buildAgentUserMessage({
      prompt: 'Move the equation below the title.',
      document: sceneDocument,
      definitions: registryRows,
      userId: USER_ID,
      iteration: 2,
      turn: 1,
      limits: resolveAgentLimits(),
      toolCallsUsed: 3,
      operationsApplied: 1,
      observations: [
        { tool: 'findOverlaps', args: '{"instanceIds":["x"]}', result: { pairs: [] } },
      ],
      feedback: { kind: 'verification', issues: ['Instances overlap'] },
      priorIterations: [
        {
          iteration: 1,
          planOperations: 1,
          applied: [{ type: 'moveInstance', id: EQUATION_ID }],
          verification: { passed: false, issues: ['Instances overlap'] },
        },
      ],
      createdObjects: [{ kind: 'instance', clientKey: 'title', id: FIRST_CREATED_ID }],
    });

    expect(message).toContain('Move the equation below the title.');
    expect(message).toContain('maxIterations');
    expect(message).toContain('getInstanceBounds');
    expect(message).toContain('findOverlaps');
    expect(message).toContain('Instances overlap');
    expect(message).toContain(FIRST_CREATED_ID);
    expect(message).toContain('createdThisRequest');
    // No repository internals, no credentials, no SQL.
    expect(message).not.toContain('process.env');
    expect(message).not.toContain('OPENROUTER');
    expect(message).not.toContain('drizzle');
    expect(message).not.toContain('SELECT ');
    expect(message).not.toContain('/src/');
  });

  it('bounds the number of observations carried into one message', () => {
    const observations = Array.from({ length: 20 }, (_, index) => ({
      tool: 'findInstances',
      args: `{"n":${index}}`,
      result: {},
    }));
    const message = buildAgentUserMessage({
      prompt: 'inspect',
      document: sceneDocument,
      definitions: registryRows,
      userId: USER_ID,
      iteration: 1,
      turn: 4,
      limits: resolveAgentLimits(),
      toolCallsUsed: 10,
      operationsApplied: 0,
      observations,
      feedback: null,
      priorIterations: [],
      createdObjects: [],
    });
    expect(message).toContain(String.raw`{\"n\":19}`);
    expect(message).toContain(String.raw`{\"n\":12}`);
    expect(message).not.toContain(String.raw`{\"n\":11}`);
    expect(MAX_CONTEXT_OBSERVATIONS).toBe(8);
  });
});
