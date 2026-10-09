import { randomUUID } from 'node:crypto';
import type { AIModelConfig } from './provider.js';

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

/**
 * Bounded agent request metadata (Stage 4B). Adds loop-level counters and
 * the termination reason; still payload-free — no prompts, no scene
 * contents, no model responses.
 */
export interface AIAgentRequestMeta extends AIRequestMeta {
  iterations?: number;
  toolCalls?: number;
  modelCalls?: number;
  operationCount?: number;
  terminationStatus?: string;
}

export const newAIAgentRequestMeta = (input: {
  sceneId: string;
  config: Pick<AIModelConfig, 'provider' | 'model'>;
  contextVersion: string;
  requestId?: string;
  startedAt?: string;
}): AIAgentRequestMeta => ({ ...newAIRequestMeta(input) });

export const finishAIAgentRequestMeta = (
  meta: AIAgentRequestMeta,
  outcome: {
    success: boolean;
    latencyMs: number;
    terminationStatus: string;
    iterations: number;
    toolCalls: number;
    modelCalls: number;
    operationCount: number;
    errorCode?: string;
    usage?: AIRequestMeta['usage'];
  },
): AIAgentRequestMeta => ({
  ...meta,
  success: outcome.success,
  ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  latencyMs: outcome.latencyMs,
  terminationStatus: outcome.terminationStatus,
  iterations: outcome.iterations,
  toolCalls: outcome.toolCalls,
  modelCalls: outcome.modelCalls,
  operationCount: outcome.operationCount,
  ...(outcome.usage ? { usage: outcome.usage } : {}),
});
