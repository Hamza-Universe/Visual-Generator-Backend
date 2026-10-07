import type { AISceneProvider } from './provider.js';
import { buildSystemPrompt } from './systemPrompt.js';
import type { AIContext } from './context.js';
import { AIScenePlanSchema, type AIScenePlan } from './operations.js';
import type { AIStructuredResult } from './provider.js';

/**
 * AI planning orchestration (Stage 4A): user intent → selective context →
 * provider → Zod-validated plan. Single-shot only: no agent loop, no
 * retries that mutate, no memory.
 */
export interface PlanSceneEditResult {
  plan: AIScenePlan;
  meta: {
    provider: string;
    model: string;
    contextVersion: string;
    latencyMs: number;
    usage?: AIStructuredResult<unknown>['usage'];
  };
}

export const planSceneEdit = async (input: {
  provider: AISceneProvider;
  context: AIContext;
  prompt: string;
}): Promise<PlanSceneEditResult> => {
  const system = buildSystemPrompt();
  const user = [
    `Scene context (contract v${input.context.version}):`,
    JSON.stringify(input.context),
    '',
    `User request: ${input.prompt}`,
    '',
    'Return the operation plan JSON object now.',
  ].join('\n');
  const result = await input.provider.generateStructured(
    { system: system.text, user, schemaName: 'AIScenePlan' },
    AIScenePlanSchema,
  );
  return {
    plan: result.data,
    meta: {
      provider: input.provider.provider,
      model: input.provider.model,
      contextVersion: system.version,
      latencyMs: result.latencyMs,
      ...(result.usage ? { usage: result.usage } : {}),
    },
  };
};
