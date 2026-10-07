/**
 * Manual live smoke test for the Stage 4A AI harness.
 *
 * Sends exactly ONE OpenRouter request, validates the structured plan
 * against a fixture document, and prints it. The automated test suite
 * never runs this script (no key required, no free-tier requests burned).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... pnpm --filter @app/api exec tsx scripts/ai-smoke.ts
 *
 * Exit codes: 0 = valid plan, 1 = plan failed validation, 2 = no key.
 */
import { buildAIContext } from '../src/ai/context.js';
import { createSceneAIProvider } from '../src/ai/provider.js';
import { planSceneEdit } from '../src/ai/planner.js';
import { validateScenePlan, type AIPlanDefinition } from '../src/ai/apply.js';
import type { SceneDocument } from '@app/schema';

const apiKey = process.env.OPENROUTER_API_KEY ?? '';
if (!apiKey) {
  console.log('[ai-smoke] OPENROUTER_API_KEY is not set; skipping live test.');
  process.exit(2);
}

const LABEL_DEF_ID = '77777777-7777-4777-8777-777777777777';

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

const document: SceneDocument = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  name: 'F = ma smoke',
  timeline: { fps: 30, durationFrames: 300 },
  components: [],
  groups: [],
};

const context = buildAIContext({
  document,
  definitions: [
    { ...labelDefinition, userId: null, isPublic: true } as never,
  ],
  userId: '33333333-3333-4333-8333-333333333333',
});

const provider = createSceneAIProvider({
  apiKey,
  model: process.env.OPENROUTER_MODEL ?? 'openrouter/free',
  baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
});

const { plan, meta } = await planSceneEdit({
  provider,
  context,
  prompt:
    'Create a visual explanation of F = ma: add a Label reading "F = ma" near the top-left.',
});

console.log('[ai-smoke] meta:', JSON.stringify(meta, null, 2));
console.log('[ai-smoke] plan:', JSON.stringify(plan, null, 2));

const issues = validateScenePlan({
  document,
  definitions: [labelDefinition],
  plan,
});
if (issues.length > 0) {
  console.error('[ai-smoke] plan failed domain validation:', issues);
  process.exit(1);
}
console.log(
  `[ai-smoke] OK — ${plan.operations.length} operation(s) validated against the fixture document.`,
);
