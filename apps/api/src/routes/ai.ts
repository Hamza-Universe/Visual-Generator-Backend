import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@app/db';
import { AppError, sendError } from '../errors.js';
import { buildAIContext } from '../ai/context.js';
import { createSceneAIProvider } from '../ai/provider.js';
import { planSceneEdit } from '../ai/planner.js';
import { applyScenePlan, fetchSceneDocument, parseAIPlan } from '../ai/apply.js';
import { finishAIRequestMeta, finishAIAgentRequestMeta, newAIRequestMeta, newAIAgentRequestMeta } from '../ai/observability.js';
import { buildSystemPrompt, AI_AGENT_CONTEXT_VERSION } from '../ai/systemPrompt.js';
import { listDefinitionsForAI } from '../ai/registry.js';
import { runSceneAgent, type AIAgentLimits } from '../ai/agent.js';

export interface AIRouteConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Server-side bounded-agent limits (Stage 4B); never client-supplied. */
  agent?: Partial<AIAgentLimits>;
}

const PlanRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  selection: z
    .object({ instanceIds: z.array(z.string().uuid()).max(50).optional() })
    .optional(),
});

/**
 * Scene AI endpoints (Stage 4A + 4B).
 *
 * POST /scenes/:sceneId/ai/plan   — planning only, never mutates.
 * POST /scenes/:sceneId/ai/apply  — re-validates the plan against a
 * fresh document snapshot, then applies it through the existing
 * domain mutations. No autonomous loops, no direct DB writes here.
 * POST /scenes/:sceneId/ai/execute — bounded agentic execution:
 * inspect (allowlisted read tools) → plan → validate → apply → verify →
 * bounded correction, with application-owned iteration, tool, operation,
 * and time budgets. It drives the same validated application path —
 * still exactly one write mechanism. Post-execution outcomes
 * (completed, max_iterations, provider_error, …) return 200 with an
 * explicit `status` so the client can refresh after any partial
 * application; pre-execution failures (bad input, unauthorized scene,
 * missing model) use the usual error responses.
 */
export const registerAIRoutes = (
  app: FastifyInstance,
  db: Database,
  aiConfig: AIRouteConfig,
) => {
  app.post('/scenes/:id/ai/plan', async (request, reply) => {
    const startedAt = Date.now();
    const sceneId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const meta = newAIRequestMeta({
      sceneId,
      config: { provider: 'openrouter', model: aiConfig.model },
      contextVersion: buildSystemPrompt().version,
    });
    try {
      const parsed = PlanRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('BAD_INPUT', 'Invalid AI plan request', 400, parsed.error.issues);
      }
      const document = await fetchSceneDocument(db, sceneId, userId);
      const definitions = await listDefinitionsForAI(db, userId);
      const context = buildAIContext({
        document,
        definitions,
        userId,
        selection: parsed.data.selection,
      });
      const provider = createSceneAIProvider(aiConfig);
      const { plan, meta: planMeta } = await planSceneEdit({
        provider,
        context,
        prompt: parsed.data.prompt,
      });
      request.log.info(
        finishAIRequestMeta(meta, {
          success: true,
          latencyMs: Date.now() - startedAt,
          usage: planMeta.usage,
        }),
        'ai.plan.ok',
      );
      return reply.send({
        plan,
        meta: { ...planMeta, requestId: meta.requestId, sceneId },
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      request.log.info(
        finishAIRequestMeta(meta, {
          success: false,
          errorCode: code,
          latencyMs: Date.now() - startedAt,
        }),
        'ai.plan.error',
      );
      return sendError(reply, error);
    }
  });

  app.post('/scenes/:id/ai/apply', async (request, reply) => {
    const startedAt = Date.now();
    const sceneId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const meta = newAIRequestMeta({
      sceneId,
      config: { provider: 'openrouter', model: aiConfig.model },
      contextVersion: buildSystemPrompt().version,
    });
    try {
      const plan = parseAIPlan((request.body as { plan?: unknown } | null)?.plan);
      const definitions = await listDefinitionsForAI(db, userId);
      const result = await applyScenePlan({ db, sceneId, userId, definitions, plan });
      request.log.info(
        finishAIRequestMeta(meta, { success: true, latencyMs: Date.now() - startedAt }),
        'ai.apply.ok',
      );
      return reply.send({
        applied: result.applied,
        document: result.document,
        meta: { requestId: meta.requestId, sceneId },
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      request.log.info(
        finishAIRequestMeta(meta, {
          success: false,
          errorCode: code,
          latencyMs: Date.now() - startedAt,
        }),
        'ai.apply.error',
      );
      return sendError(reply, error);
    }
  });

  app.post('/scenes/:id/ai/execute', async (request, reply) => {
    const startedAt = Date.now();
    const sceneId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const meta = newAIAgentRequestMeta({
      sceneId,
      config: { provider: 'openrouter', model: aiConfig.model },
      contextVersion: AI_AGENT_CONTEXT_VERSION,
    });
    try {
      const parsed = PlanRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('BAD_INPUT', 'Invalid AI execute request', 400, parsed.error.issues);
      }
      // Authorization first: 403/404 before any model call or cost.
      const document = await fetchSceneDocument(db, sceneId, userId);
      const definitions = await listDefinitionsForAI(db, userId);
      const provider = createSceneAIProvider(aiConfig);
      const result = await runSceneAgent({
        db,
        sceneId,
        userId,
        prompt: parsed.data.prompt,
        ...(parsed.data.selection ? { selection: parsed.data.selection } : {}),
        provider,
        document,
        definitions,
        ...(aiConfig.agent ? { limits: aiConfig.agent } : {}),
      });
      request.log.info(
        finishAIAgentRequestMeta(meta, {
          success: result.status === 'completed',
          ...(result.status !== 'completed' ? { errorCode: result.status } : {}),
          latencyMs: Date.now() - startedAt,
          terminationStatus: result.status,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          modelCalls: result.modelCalls,
          operationCount: result.appliedOperations.length,
          ...(result.meta.usage ? { usage: result.meta.usage } : {}),
        }),
        'ai.execute.ok',
      );
      return reply.send({
        ...result,
        meta: { ...result.meta, requestId: meta.requestId, sceneId },
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      request.log.info(
        finishAIAgentRequestMeta(meta, {
          success: false,
          errorCode: code,
          latencyMs: Date.now() - startedAt,
          terminationStatus: 'error',
          iterations: 0,
          toolCalls: 0,
          modelCalls: 0,
          operationCount: 0,
        }),
        'ai.execute.error',
      );
      return sendError(reply, error);
    }
  });
};
