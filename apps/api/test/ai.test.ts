import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SceneDocument } from '@app/schema';
import { AppError } from '../src/errors.js';
import {
  extractJsonText,
  OpenRouterProvider,
  createSceneAIProvider,
  resolveAIModelConfig,
  type AISceneProvider,
} from '../src/ai/provider.js';
import { buildAIContext, MAX_AI_CONTEXT_INSTANCES } from '../src/ai/context.js';
import { AIScenePlanSchema, MAX_AI_PLAN_OPERATIONS } from '../src/ai/operations.js';
import {
  parseAIPlan,
  validateScenePlan,
  applyScenePlan,
  type AIPlanDefinition,
} from '../src/ai/apply.js';
import { planSceneEdit } from '../src/ai/planner.js';
import { AI_CONTEXT_VERSION } from '../src/ai/systemPrompt.js';
import {
  createInstance,
  requireSceneAccess,
  updateInstance,
} from '../src/services/documents.js';

vi.mock('../src/services/documents.js', () => ({
  requireSceneAccess: vi.fn(async () => ({ scene: { id: 'scene-1' }, project: {} })),
  getSceneDocument: vi.fn(async () => document),
  createInstance: vi.fn(
    async (_db: unknown, _sceneId: string, _userId: string, input: unknown) => ({
      id: 'created-instance-id',
      ...((input ?? {}) as Record<string, unknown>),
    }),
  ),
  updateInstance: vi.fn(
    async (_db: unknown, id: string, _userId: string, input: unknown) => ({
      id,
      ...((input ?? {}) as Record<string, unknown>),
    }),
  ),
  deleteInstance: vi.fn(async () => undefined),
  createGroup: vi.fn(
    async (_db: unknown, _sceneId: string, _userId: string, input: unknown) => ({
      id: 'created-group-id',
      ...((input ?? {}) as Record<string, unknown>),
    }),
  ),
  deleteGroup: vi.fn(async () => undefined),
}));

const SCENE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const LABEL_ID = '55555555-5555-4555-8555-555555555555';
const ARROW_ID = '66666666-6666-4666-8666-666666666666';
const LABEL_DEF_ID = '77777777-7777-4777-8777-777777777777';
const ARROW_DEF_ID = '88888888-8888-4888-8888-888888888888';
const GROUP_ID = '99999999-9999-4999-8999-999999999999';
const MISSING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const labelDefinition: AIPlanDefinition = {
  id: LABEL_DEF_ID,
  name: 'Label',
  description: 'A text label',
  propsSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      fontSize: { type: 'number' },
    },
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
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      color: { type: 'string' },
    },
  },
  defaultProps: { from: '', to: '', color: '#000000' },
  refProps: ['from', 'to'],
};

const secretDefinition: AIPlanDefinition = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Secret',
  description: 'Private to another user',
  propsSchema: { type: 'object', properties: {} },
  defaultProps: {},
  refProps: [],
};

// Registry rows carry the visibility fields used by
// `isComponentVisibleToUser`; the AI definitions above are the
// already-authorized subset.
const registryRows = [
  { ...labelDefinition, userId: null, isPublic: true },
  { ...arrowDefinition, userId: USER_ID, isPublic: false },
  { ...secretDefinition, userId: OTHER_USER_ID, isPublic: false },
];

const document: SceneDocument = {
  id: SCENE_ID,
  projectId: PROJECT_ID,
  name: 'F = ma',
  timeline: { fps: 30, durationFrames: 300 },
  components: [
    {
      id: LABEL_ID,
      sceneId: SCENE_ID,
      componentDefinitionId: LABEL_DEF_ID,
      groupId: null,
      props: { text: 'F = ma', fontSize: 24 },
      position: { x: 100, y: 120 },
      size: { width: 220, height: 48 },
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { opacity: 1 },
      visible: true,
      zIndex: 0,
      timing: { start: 0, duration: 2 },
      animation: { enter: [], exit: [], keyframes: [] },
    },
    {
      id: ARROW_ID,
      sceneId: SCENE_ID,
      componentDefinitionId: ARROW_DEF_ID,
      groupId: null,
      props: { from: LABEL_ID, to: LABEL_ID, color: '#000000' },
      position: { x: 0, y: 0 },
      size: { width: 100, height: 100 },
      transform: { rotation: 0, scaleX: 1, scaleY: 1 },
      style: { opacity: 1 },
      visible: true,
      zIndex: 1,
      timing: { start: 0, duration: 2 },
      animation: { enter: [], exit: [], keyframes: [] },
    },
  ],
  groups: [
    { id: GROUP_ID, sceneId: SCENE_ID, parentGroupId: null, name: 'Equation', zIndex: 0 },
  ],
};

const definitions = [labelDefinition, arrowDefinition];

const fakeResponse = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenRouter provider', () => {
  it('refuses to construct without an API key', () => {
    expect(
      () => new OpenRouterProvider('openrouter/free', { apiKey: '' }),
    ).toThrowError(AppError);
    try {
      new OpenRouterProvider('openrouter/free', { apiKey: '' });
    } catch (error) {
      expect((error as AppError).code).toBe('AI_MODEL_UNAVAILABLE');
      expect((error as AppError).statusCode).toBe(503);
    }
  });

  it('sends system/user messages and requests JSON output', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ choices: [{ message: { content: '{"operations":[]}' } }] }),
    );
    const provider = new OpenRouterProvider('test-model', {
      apiKey: 'secret-key',
      fetchImpl,
    });
    await provider.generateStructured(
      { system: 'sys', user: 'usr', schemaName: 'AIScenePlan' },
      planSchema(),
    );
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer secret-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('parses fenced JSON and captures token usage', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        choices: [{ message: { content: '```json\n{"operations":[]}\n```' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const provider = new OpenRouterProvider('m', { apiKey: 'k', fetchImpl });
    const result = await provider.generateStructured(
      { system: 's', user: 'u', schemaName: 'AIScenePlan' },
      planSchema(),
    );
    expect(result.data).toEqual({ operations: [] });
    expect(result.usage?.totalTokens).toBe(15);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('maps provider HTTP failures without leaking the key', async () => {
    const provider = new OpenRouterProvider('m', {
      apiKey: 'secret-key',
      fetchImpl: async () => fakeResponse({}, false, 500),
    });
    await expect(
      provider.generateStructured(
        { system: 's', user: 'u', schemaName: 'AIScenePlan' },
        planSchema(),
      ),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR', statusCode: 502 });
    try {
      await provider.generateStructured(
        { system: 's', user: 'u', schemaName: 'AIScenePlan' },
        planSchema(),
      );
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-key');
    }
  });

  it('maps network failures to AI_PROVIDER_ERROR', async () => {
    const provider = new OpenRouterProvider('m', {
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      provider.generateStructured(
        { system: 's', user: 'u', schemaName: 'AIScenePlan' },
        planSchema(),
      ),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
  });

  it('maps unreadable bodies to AI_INVALID_RESPONSE', async () => {
    const provider = new OpenRouterProvider('m', {
      apiKey: 'k',
      fetchImpl: async () =>
        fakeResponse({ choices: [{ message: { content: 'not json at all' } }] }),
    });
    await expect(
      provider.generateStructured(
        { system: 's', user: 'u', schemaName: 'AIScenePlan' },
        planSchema(),
      ),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('maps schema mismatches to AI_SCHEMA_ERROR with issues', async () => {
    const provider = new OpenRouterProvider('m', {
      apiKey: 'k',
      fetchImpl: async () =>
        fakeResponse({
          choices: [{ message: { content: '{"operations":[{"type":"bogus"}]}' } }],
        }),
    });
    await expect(
      provider.generateStructured(
        { system: 's', user: 'u', schemaName: 'AIScenePlan' },
        planSchema(),
      ),
    ).rejects.toMatchObject({
      code: 'AI_SCHEMA_ERROR',
      statusCode: 502,
    });
  });

  it('resolves the model from configuration only', () => {
    expect(resolveAIModelConfig({ model: '' }).model).toBe('openrouter/free');
    expect(resolveAIModelConfig({ model: 'anthropic/x' }).model).toBe('anthropic/x');
    const provider = createSceneAIProvider({ apiKey: 'k', model: 'custom/model' });
    expect(provider.provider).toBe('openrouter');
    expect(provider.model).toBe('custom/model');
  });
});

// The real plan schema, used by the transport tests to prove the
// provider validates model output before returning typed data.
const planSchema = () => AIScenePlanSchema;

describe('extractJsonText', () => {
  it('strips markdown code fences', () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });
});

describe('AI context builder', () => {
  it('builds selective scene metadata and instance context', () => {
    const context = buildAIContext({
      document,
      definitions: registryRows as never,
      userId: USER_ID,
      selection: { instanceIds: [LABEL_ID] },
    });
    expect(context.version).toBe(AI_CONTEXT_VERSION);
    expect(context.scene).toMatchObject({
      id: SCENE_ID,
      name: 'F = ma',
      fps: 30,
      durationFrames: 300,
      instanceCount: 2,
      groupCount: 1,
    });
    const label = context.instances.find((i) => i.id === LABEL_ID);
    expect(label).toMatchObject({
      definition: 'Label',
      label: 'F = ma',
      position: { x: 100, y: 120 },
      selected: true,
    });
    expect(context.instances.find((i) => i.id === ARROW_ID)?.selected).toBe(
      false,
    );
  });

  it('includes component definitions with compact props and ref props', () => {
    const context = buildAIContext({
      document,
      definitions: registryRows as never,
      userId: USER_ID,
    });
    expect(context.definitions.map((d) => d.name)).toEqual(['Label', 'Arrow']);
    expect(context.definitions[0].props).toContainEqual({
      name: 'text',
      type: 'string',
    });
    expect(context.definitions[1].refProps).toEqual(['from', 'to']);
  });

  it('filters private definitions belonging to other users', () => {
    const context = buildAIContext({
      document,
      definitions: registryRows as never,
      userId: USER_ID,
    });
    expect(context.definitions.some((d) => d.name === 'Secret')).toBe(false);
  });

  it('keeps the requesting user\'s private definitions', () => {
    const context = buildAIContext({
      document,
      definitions: [
        { ...arrowDefinition, userId: USER_ID, isPublic: false },
      ] as never,
      userId: USER_ID,
    });
    expect(context.definitions.map((d) => d.name)).toEqual(['Arrow']);
  });

  it('caps context size and reports truncation', () => {
    const big: SceneDocument = {
      ...document,
      components: Array.from({ length: MAX_AI_CONTEXT_INSTANCES + 5 }, (_, i) => ({
        ...document.components[0],
        id: `${i}${'a'.repeat(35)}`,
      })),
    };
    const context = buildAIContext({
      document: big,
      definitions: registryRows as never,
      userId: USER_ID,
    });
    expect(context.instances).toHaveLength(MAX_AI_CONTEXT_INSTANCES);
    expect(context.scene.truncatedInstances).toBe(true);
    expect(context.scene.instanceCount).toBe(MAX_AI_CONTEXT_INSTANCES + 5);
  });

  it('documents the available operations in the instructions', () => {
    const context = buildAIContext({
      document,
      definitions: registryRows as never,
      userId: USER_ID,
    });
    expect(context.instructions).toContain('createInstance');
    expect(context.instructions).toContain('deleteKeyframe');
    expect(context.instructions).toContain('clientKey');
  });
});

describe('AI plan validation', () => {
  it('accepts a valid createInstance operation', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'createInstance',
            clientKey: 'eq',
            definitionName: 'Label',
            props: { text: 'E = mc²', fontSize: 20 },
            position: { x: 10, y: 20 },
          },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it('accepts an empty plan', () => {
    expect(
      validateScenePlan({ document, definitions, plan: { operations: [] } }),
    ).toEqual([]);
  });

  it('rejects an unknown component definition name', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          { type: 'createInstance', clientKey: 'x', definitionName: 'Nope' },
        ],
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ opIndex: 0, path: 'definitionName' });
  });

  it('rejects definitions outside the user\'s authorized set', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          { type: 'createInstance', clientKey: 'x', definitionName: 'Secret' },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'definitionName' });
  });

  it('rejects props that violate the definition schema', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'createInstance',
            clientKey: 'x',
            definitionName: 'Label',
            props: { fontSize: 'big' },
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'props' });
  });

  it('rejects operations targeting instances that do not exist', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'moveInstance',
            instanceId: MISSING_ID,
            position: { x: 0, y: 0 },
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'instanceId' });
  });

  it('rejects references to instances that do not exist', () => {
    const issues = validateScenePlan({
      document,
      definitions,
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
    });
    expect(issues[0]).toMatchObject({ path: 'targetInstanceId' });
  });

  it('rejects setting a non-reference prop as a reference', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'setReference',
            instanceId: ARROW_ID,
            prop: 'color',
            targetInstanceId: LABEL_ID,
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'prop' });
  });

  it('rejects self-references', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'setReference',
            instanceId: ARROW_ID,
            prop: 'from',
            targetInstanceId: ARROW_ID,
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'targetInstanceId' });
  });

  it('rejects deleting an instance that is referenced', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [{ type: 'deleteInstance', instanceId: LABEL_ID }],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'instanceId' });
  });

  it('rejects duplicate clientKeys within a plan', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          { type: 'createInstance', clientKey: 'dup', definitionName: 'Label' },
          { type: 'createInstance', clientKey: 'dup', definitionName: 'Label' },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'clientKey', opIndex: 1 });
  });

  it('rejects forward clientKey references', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'setReference',
            instanceId: ARROW_ID,
            prop: 'from',
            targetClientKey: 'not-yet-created',
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'targetClientKey' });
  });

  it('accepts clientKey references to earlier operations in the plan', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          { type: 'createInstance', clientKey: 'eq', definitionName: 'Label' },
          {
            type: 'setReference',
            instanceId: ARROW_ID,
            prop: 'from',
            targetClientKey: 'eq',
          },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it('accepts group placement for existing groups and created groups', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          { type: 'createGroup', clientKey: 'g1', name: 'Layer' },
          {
            type: 'createInstance',
            clientKey: 'in',
            definitionName: 'Label',
            groupClientKey: 'g1',
          },
          {
            type: 'createInstance',
            clientKey: 'in2',
            definitionName: 'Label',
            groupId: GROUP_ID,
          },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it('rejects placement into groups that do not exist', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'createInstance',
            clientKey: 'in',
            definitionName: 'Label',
            groupId: MISSING_ID,
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'groupId' });
  });

  it('rejects keyframes outside the scene duration', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'addAnimationTrack',
            instanceId: LABEL_ID,
            property: 'position.x',
            keyframes: [{ frame: 500, value: 10 }],
          },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'frame' });
  });

  it('accepts keyframes inside the scene duration', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          {
            type: 'addAnimationTrack',
            instanceId: LABEL_ID,
            property: 'position.x',
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 299, value: 100, easing: 'easeInOut' },
            ],
          },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it('rejects malformed updateProps merges', () => {
    const issues = validateScenePlan({
      document,
      definitions,
      plan: {
        operations: [
          { type: 'updateProps', instanceId: LABEL_ID, props: { text: 42 } },
        ],
      },
    });
    expect(issues[0]).toMatchObject({ path: 'props' });
  });
});

describe('AI plan schema', () => {
  it('parses a valid plan', () => {
    const plan = parseAIPlan({ operations: [] });
    expect(plan.operations).toEqual([]);
  });

  it('rejects plans exceeding the operation cap', () => {
    const operations = Array.from(
      { length: MAX_AI_PLAN_OPERATIONS + 1 },
      (_, i) => ({
        type: 'deleteInstance' as const,
        instanceId: `00000000-0000-4000-8000-00000000000${i % 10}`,
      }),
    );
    expect(() => parseAIPlan({ operations })).toThrowError(AppError);
  });

  it('rejects structurally invalid plans', () => {
    expect(() => parseAIPlan({ operations: [{ type: 'bogus' }] })).toThrowError(
      AppError,
    );
    expect(() => parseAIPlan(null)).toThrowError(AppError);
  });
});

describe('AI planning orchestration', () => {
  const fakeProvider: AISceneProvider = {
    provider: 'openrouter',
    model: 'test-model',
    generateStructured: vi.fn(async () => ({
      data: {
        operations: [
          { type: 'createInstance', clientKey: 'a', definitionName: 'Label' },
        ],
      },
      latencyMs: 42,
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    })),
  };

  it('returns a validated plan with request metadata', async () => {
    const context = buildAIContext({
      document,
      definitions: registryRows as never,
      userId: USER_ID,
    });
    const { plan, meta } = await planSceneEdit({
      provider: fakeProvider,
      context,
      prompt: 'Add a label',
    });
    expect(plan.operations).toHaveLength(1);
    expect(meta).toMatchObject({
      provider: 'openrouter',
      model: 'test-model',
      contextVersion: AI_CONTEXT_VERSION,
      latencyMs: 42,
    });
    expect(meta.usage?.totalTokens).toBe(110);
  });

  it('sends only the selective context and prompt — never repository code', async () => {
    const context = buildAIContext({
      document,
      definitions: registryRows as never,
      userId: USER_ID,
    });
    await planSceneEdit({
      provider: fakeProvider,
      context,
      prompt: 'Move the equation right',
    });
    expect(fakeProvider.generateStructured).toHaveBeenCalledTimes(1);
    const request = fakeProvider.generateStructured.mock.calls[0][0];
    expect(request.system).toContain('visual scene authoring model');
    expect(request.user).toContain(JSON.stringify(context));
    expect(request.user).toContain('Move the equation right');
    expect(request.user).not.toContain('drizzle');
    expect(request.schemaName).toBe('AIScenePlan');
  });
});

describe('AI OpenAPI contract', () => {
  const document = JSON.parse(
    readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'),
  ) as {
    paths: Record<
      string,
      Record<string, { responses?: Record<string, unknown>; security?: unknown[] }>
    >;
    components: { schemas: Record<string, unknown> };
  };

  it('documents both AI endpoints with auth and responses', () => {
    const plan = document.paths['/scenes/{id}/ai/plan'].post;
    expect(plan.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(plan.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '404', '502', '503']),
    );
    const apply = document.paths['/scenes/{id}/ai/apply'].post;
    expect(apply.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(apply.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '404', '422']),
    );
  });

  it('exposes the plan and apply schemas', () => {
    for (const name of [
      'AIPlanRequest',
      'AIPlanResponse',
      'AIApplyRequest',
      'AIApplyResponse',
      'AIPlan',
      'AIOperation',
    ]) {
      expect(document.components.schemas[name], name).toBeDefined();
    }
  });
});

describe('AI plan application', () => {
  it('applies a valid plan through the existing domain mutations', async () => {
    const result = await applyScenePlan({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      definitions,
      plan: {
        operations: [
          {
            type: 'createInstance',
            clientKey: 'eq',
            definitionName: 'Label',
            props: { text: 'E = mc²' },
            position: { x: 5, y: 6 },
          },
        ],
      },
    });
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(createInstance).toHaveBeenCalledWith(
      {} as never,
      SCENE_ID,
      USER_ID,
      expect.objectContaining({
        componentDefinitionId: LABEL_DEF_ID,
        props: { text: 'E = mc²' },
        position: { x: 5, y: 6 },
        visible: true,
        zIndex: 0,
      }),
    );
    expect(result.applied).toEqual([
      { index: 0, type: 'createInstance', id: 'created-instance-id' },
    ]);
    expect(result.document.components).toHaveLength(2);
  });

  it('applies nothing when a plan fails validation', async () => {
    await expect(
      applyScenePlan({
        db: {} as never,
        sceneId: SCENE_ID,
        userId: USER_ID,
        definitions,
        plan: {
          operations: [
            { type: 'moveInstance', instanceId: MISSING_ID, position: { x: 0, y: 0 } },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'AI_OPERATION_INVALID', statusCode: 422 });
    expect(createInstance).not.toHaveBeenCalled();
    expect(updateInstance).not.toHaveBeenCalled();
  });

  it('enforces scene authorization before any mutation', async () => {
    vi.mocked(requireSceneAccess).mockRejectedValueOnce(
      new AppError('FORBIDDEN', 'Scene is not accessible', 403),
    );
    await expect(
      applyScenePlan({
        db: {} as never,
        sceneId: SCENE_ID,
        userId: USER_ID,
        definitions,
        plan: { operations: [] },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('resolves clientKey references to the created instance ids', async () => {
    await applyScenePlan({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      definitions,
      plan: {
        operations: [
          { type: 'createInstance', clientKey: 'eq', definitionName: 'Label' },
          {
            type: 'setReference',
            instanceId: ARROW_ID,
            prop: 'from',
            targetClientKey: 'eq',
          },
        ],
      },
    });
    expect(updateInstance).toHaveBeenCalledWith(
      {} as never,
      ARROW_ID,
      USER_ID,
      expect.objectContaining({
        props: expect.objectContaining({ from: 'created-instance-id' }),
      }),
    );
  });

  it('merges updateProps over the current instance props', async () => {
    await applyScenePlan({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      definitions,
      plan: {
        operations: [
          { type: 'updateProps', instanceId: LABEL_ID, props: { fontSize: 30 } },
        ],
      },
    });
    expect(updateInstance).toHaveBeenCalledWith(
      {} as never,
      LABEL_ID,
      USER_ID,
      expect.objectContaining({
        props: { text: 'F = ma', fontSize: 30 },
      }),
    );
  });

  it('merges updateStyle over the current instance style', async () => {
    await applyScenePlan({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      definitions,
      plan: {
        operations: [{ type: 'updateStyle', instanceId: LABEL_ID, style: { opacity: 0.5 } }],
      },
    });
    expect(updateInstance).toHaveBeenCalledWith(
      {} as never,
      LABEL_ID,
      USER_ID,
      expect.objectContaining({ style: { opacity: 0.5 } }),
    );
  });

  it('applies animation tracks through the canonical timeline shape', async () => {
    await applyScenePlan({
      db: {} as never,
      sceneId: SCENE_ID,
      userId: USER_ID,
      definitions,
      plan: {
        operations: [
          {
            type: 'addAnimationTrack',
            instanceId: LABEL_ID,
            property: 'position.x',
            keyframes: [
              { frame: 30, value: 100, easing: 'easeIn' },
              { frame: 0, value: 0 },
            ],
          },
        ],
      },
    });
    expect(updateInstance).toHaveBeenCalledWith(
      {} as never,
      LABEL_ID,
      USER_ID,
      expect.objectContaining({
        animation: expect.objectContaining({
          tracks: [
            {
              property: 'position.x',
              keyframes: [
                { frame: 0, value: 0, easing: 'linear' },
                { frame: 30, value: 100, easing: 'easeIn' },
              ],
            },
          ],
        }),
      }),
    );
  });
});
