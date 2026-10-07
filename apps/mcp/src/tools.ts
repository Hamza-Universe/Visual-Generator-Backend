import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const json = async (
  base: string,
  token: string,
  path: string,
  init?: RequestInit,
) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
};
const result = (body: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(body) }],
});
export const registerTools = (
  server: McpServer,
  base: string,
  token: string,
) => {
  server.registerTool(
    'list_components',
    {
      description:
        'GET /components. Returns the registry. Failures use the API error format.',
      inputSchema: {},
    },
    async () => result(await json(base, token, '/components')),
  );
  server.registerTool(
    'list_projects',
    {
      description:
        'GET /projects. Lists projects. Failures use the API error format.',
      inputSchema: {},
    },
    async () => result(await json(base, token, '/projects')),
  );
  server.registerTool(
    'list_assets',
    { description: 'GET /assets. Lists the authenticated user assets.', inputSchema: {} },
    async () => result(await json(base, token, '/assets')),
  );
  server.registerTool(
    'get_asset_media_url',
    { description: 'POST /assets/:id/share-url. Returns a short-lived public media URL.', inputSchema: { assetId: z.string().uuid() } },
    async ({ assetId }) => result(await json(base, token, `/assets/${assetId}/share-url`, { method: 'POST' })),
  );
  server.registerTool(
    'get_transcript',
    { description: 'GET /transcripts/:id. Returns canonical transcript JSON.', inputSchema: { transcriptId: z.string().uuid() } },
    async ({ transcriptId }) => result(await json(base, token, `/transcripts/${transcriptId}`)),
  );
  server.registerTool(
    'import_transcript',
    { description: 'POST /assets/:id/transcripts/import. Stores canonical transcript JSON.', inputSchema: { assetId: z.string().uuid(), transcript: z.unknown() } },
    async ({ assetId, transcript }) => result(await json(base, token, `/assets/${assetId}/transcripts/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript }) })),
  );
  server.registerTool(
    'get_generation_context',
    { description: 'GET /projects/:id/generation-context. Returns project constraints, assets, components, and an optional transcript.', inputSchema: { projectId: z.string().uuid(), transcriptId: z.string().uuid().optional() } },
    async ({ projectId, transcriptId }) => result(await json(base, token, `/projects/${projectId}/generation-context${transcriptId ? `?transcriptId=${transcriptId}` : ''}`)),
  );
  server.registerTool(
    'get_project',
    {
      description:
        'GET /projects/:id. 404 when missing; other failures use the API error format.',
      inputSchema: { projectId: z.string().uuid() },
    },
    async ({ projectId }) =>
      result(await json(base, token, `/projects/${projectId}`)),
  );
  server.registerTool(
    'validate_spec',
    {
      description: 'POST /projects/:id/validate. Returns valid and issues.',
      inputSchema: { projectId: z.string().uuid(), spec: z.unknown() },
    },
    async ({ projectId, spec }) =>
      result(
        await json(base, token, `/projects/${projectId}/validate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        }),
      ),
  );
  server.registerTool(
    'submit_spec',
    { description: 'PUT /projects/:id. Saves a locally validated project spec.', inputSchema: { projectId: z.string().uuid(), spec: z.unknown() } },
    async ({ projectId, spec }) => result(await json(base, token, `/projects/${projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec }) })),
  );
  server.registerTool(
    'generate_spec',
    {
      description:
        'POST /projects/:id/generate. A 500 MISSING_CONFIG means use build_manual_prompt instead.',
      inputSchema: {
        projectId: z.string().uuid(),
        transcriptId: z.string().uuid(),
        instructions: z.string().optional(),
      },
    },
    async ({ projectId, transcriptId, instructions }) =>
      result(
        await json(base, token, `/projects/${projectId}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcriptId, instructions }),
        }),
      ),
  );
  server.registerTool(
    'build_manual_prompt',
    {
      description:
        'POST /projects/:id/generate/manual-prompt. Returns a prompt for keyless generation.',
      inputSchema: {
        projectId: z.string().uuid(),
        transcriptId: z.string().uuid(),
        instructions: z.string().optional(),
      },
    },
    async ({ projectId, transcriptId, instructions }) =>
      result(
        await json(
          base,
          token,
          `/projects/${projectId}/generate/manual-prompt`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ transcriptId, instructions }),
          },
        ),
      ),
  );
  server.registerTool(
    'submit_manual_spec',
    {
      description:
        'POST /projects/:id/generate/manual-submit. Returns a spec or validation errors.',
      inputSchema: {
        projectId: z.string().uuid(),
        transcriptId: z.string().uuid(),
        rawResponse: z.string(),
      },
    },
    async ({ projectId, transcriptId, rawResponse }) =>
      result(
        await json(
          base,
          token,
          `/projects/${projectId}/generate/manual-submit`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ transcriptId, rawResponse }),
          },
        ),
      ),
  );
  server.registerTool(
    'get_scene_document',
    {
      description: 'GET /scenes/:id/document. Returns one scene with its component instances and groups.',
      inputSchema: { sceneId: z.string().uuid() },
    },
    async ({ sceneId }) =>
      result(await json(base, token, `/scenes/${sceneId}/document`)),
  );
  server.registerTool(
    'list_scenes',
    {
      description: 'GET /projects/:id/scenes. Lists first-class scenes of a project.',
      inputSchema: { projectId: z.string().uuid() },
    },
    async ({ projectId }) =>
      result(await json(base, token, `/projects/${projectId}/scenes`)),
  );
  server.registerTool(
    'list_scene_instances',
    {
      description: 'GET /scenes/:id/instances. Lists component instances in a scene.',
      inputSchema: { sceneId: z.string().uuid() },
    },
    async ({ sceneId }) =>
      result(await json(base, token, `/scenes/${sceneId}/instances`)),
  );
  server.registerTool(
    'list_scene_groups',
    {
      description: 'GET /scenes/:id/groups. Lists groups in a scene.',
      inputSchema: { sceneId: z.string().uuid() },
    },
    async ({ sceneId }) =>
      result(await json(base, token, `/scenes/${sceneId}/groups`)),
  );
  server.registerTool(
    'create_render',
    {
      description:
        'POST /projects/:id/renders. Returns 202 queued or an API error.',
      inputSchema: { projectId: z.string().uuid() },
    },
    async ({ projectId }) =>
      result(
        await json(base, token, `/projects/${projectId}/renders`, {
          method: 'POST',
        }),
      ),
  );
  server.registerTool(
    'get_render',
    {
      description: 'GET /renders/:id. Returns render status or an API error.',
      inputSchema: { renderId: z.string().uuid() },
    },
    async ({ renderId }) =>
      result(await json(base, token, `/renders/${renderId}`)),
  );
  server.registerTool(
    'plan_scene_edit',
    {
      description:
        'POST /scenes/:id/ai/plan. Generates a structured AI operation plan for review. Planning never mutates the scene; apply the plan separately once reviewed.',
      inputSchema: {
        sceneId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
      },
    },
    async ({ sceneId, prompt }) =>
      result(
        await json(base, token, `/scenes/${sceneId}/ai/plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        }),
      ),
  );
  server.registerTool(
    'apply_scene_plan',
    {
      description:
        'POST /scenes/:id/ai/apply. Re-validates a previously generated operation plan and applies it through the existing domain mutations. An invalid plan applies nothing (422 AI_OPERATION_INVALID).',
      inputSchema: {
        sceneId: z.string().uuid(),
        plan: z.object({ operations: z.array(z.unknown()).max(50) }),
      },
    },
    async ({ sceneId, plan }) =>
      result(
        await json(base, token, `/scenes/${sceneId}/ai/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plan }),
        }),
      ),
  );
};
