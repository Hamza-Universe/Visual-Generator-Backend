import { randomUUID } from 'node:crypto';
import type { AIModelConfig, AISceneProvider } from './provider.js';
import type { AIContext } from './context.js';
import { AIScenePlanSchema, type AIScenePlan } from './operations.js';

/**
 * Minimal AI request metadata (Stage 4A).
 *
 * Tracks who/what/when/how-long plus outcome — never full prompts or model
 * responses, which may contain sensitive user content. No analytics system,
 * no extra tables; logged per request by the route layer.
 */
export interface AIRequestMeta {
  requestId: string;
  sceneId: string;
  provider: string;
  model: string;
  contextVersion: string;
  startedAt: string;
  latencyMs?: number;
  success?: boolean;
  errorCode?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export const newAIRequestMeta = (input: {
  sceneId: string;
  config: Pick<AIModelConfig, 'provider' | 'model'>;
  contextVersion: string;
  requestId?: string;
  startedAt?: string;
}): AIRequestMeta => ({
  requestId: input.requestId ?? randomUUID(),
  sceneId: input.sceneId,
  provider: input.config.provider,
  model: input.config.model,
  contextVersion: input.contextVersion,
  startedAt: input.startedAt ?? new Date().toISOString(),
});

export const finishAIRequestMeta = (
  meta: AIRequestMeta,
  outcome: {
    success: boolean;
    errorCode?: string;
    latencyMs: number;
    usage?: AIRequestMeta['usage'];
  },
): AIRequestMeta => ({
  ...meta,
  success: outcome.success,
  ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  latencyMs: outcome.latencyMs,
  ...(outcome.usage ? { usage: outcome.usage } : {}),
});
