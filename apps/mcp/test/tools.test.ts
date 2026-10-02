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
  it('registers exactly nine tools', () => {
    const { server, handlers } = createFakeServer();
    registerTools(server as never, 'http://api.test', 'jwt-token');
    expect([...handlers.keys()]).toEqual([
      'list_components',
      'list_projects',
      'get_project',
      'validate_spec',
      'generate_spec',
      'build_manual_prompt',
      'submit_manual_spec',
      'create_render',
      'get_render',
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
});
