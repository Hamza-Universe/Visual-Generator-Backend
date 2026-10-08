import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools.js';

const createFakeServer = () => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (
      name: string,
      _definition: unknown,
      handler: (input: unknown) => Promise<unknown>,
    ) => handlers.set(name, handler),
  };
  return { server, handlers };
};

afterEach(() => vi.unstubAllGlobals());

describe('MCP tools', () => {
  it('registers the expected tools', () => {
    const { server, handlers } = createFakeServer();
    registerTools(server as never, 'http://api.test', 'jwt-token');
    expect([...handlers.keys()]).toEqual([
      'list_components',
      'list_projects',
      'list_assets',
      'get_asset_media_url',
      'get_transcript',
      'import_transcript',
      'get_generation_context',
      'get_project',
      'validate_spec',
      'submit_spec',
      'generate_spec',
      'build_manual_prompt',
      'submit_manual_spec',
      'get_scene_document',
      'list_scenes',
      'list_scene_instances',
      'list_scene_groups',
      'create_render',
      'get_render',
      'plan_scene_edit',
      'apply_scene_plan',
      'execute_scene_edit',
    ]);
  });

  it('forwards the configured JWT to protected API calls', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer jwt-token',
        );
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { server, handlers } = createFakeServer();
    registerTools(server as never, 'http://api.test', 'jwt-token');
    const result = await handlers.get('list_projects')!({});
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ items: [] }) }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/projects',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it('propagates API errors without replacing their response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
            status: 401,
          }),
      ),
    );
    const { server, handlers } = createFakeServer();
    registerTools(server as never, 'http://api.test', 'jwt-token');
    await expect(handlers.get('list_projects')!({})).rejects.toThrow(
      JSON.stringify({ error: { code: 'UNAUTHORIZED' } }),
    );
  });

  it('exposes the AI plan/apply tools as thin proxies to the API', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer jwt-token',
        );
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({ plan: { operations: [] }, meta: {} }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { server, handlers } = createFakeServer();
    registerTools(server as never, 'http://api.test', 'jwt-token');
    const sceneId = '11111111-1111-4111-8111-111111111111';

    await handlers.get('plan_scene_edit')!({ sceneId, prompt: 'Move it right' });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/scenes/${sceneId}/ai/plan`,
      expect.objectContaining({ method: 'POST' }),
    );
    const planInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(planInit.body))).toEqual({ prompt: 'Move it right' });

    // MCP stays a thin proxy: all plan validation/authorization happens in
    // the API, never in the MCP layer.
    await handlers.get('apply_scene_plan')!({
      sceneId,
      plan: { operations: [{ type: 'moveInstance' }] },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/scenes/${sceneId}/ai/apply`,
      expect.objectContaining({ method: 'POST' }),
    );
    const applyInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(applyInit.body))).toEqual({
      plan: { operations: [{ type: 'moveInstance' }] },
    });

    // Stage 4B bounded agent is exposed the same way: a thin proxy; every
    // budget, authorization, and validation decision stays in the API.
    await handlers.get('execute_scene_edit')!({
      sceneId,
      prompt: 'Move the equation below the title without overlapping it.',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.test/scenes/${sceneId}/ai/execute`,
      expect.objectContaining({ method: 'POST' }),
    );
    const executeInit = fetchMock.mock.calls[2][1] as RequestInit;
    expect(JSON.parse(String(executeInit.body))).toEqual({
      prompt: 'Move the equation below the title without overlapping it.',
    });
  });
});
