import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@app/db';
import { AppError, sendError } from '../errors.js';
import { buildAIContext } from '../ai/context.js';
import { createSceneAIProvider } from '../ai/provider.js';
import { planSceneEdit } from '../ai/planner.js';
import { applyScenePlan, fetchSceneDocument, parseAIPlan } from '../ai/apply.js';
import { finishAIRequestMeta, newAIRequestMeta } from '../ai/observability.js';
import { buildSystemPrompt } from '../ai/systemPrompt.js';
import { listDefinitionsForAI } from '../ai/registry.js';

export interface AIRouteConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const PlanRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  selection: z
    .object({ instanceIds: z.array(z.string().uuid()).max(50).optional() })
    .optional(),
});

/**
 * Scene AI endpoints (Stage 4A).
 *
 * POST /scenes/:sceneId/ai/plan  — planning only, never mutates.
 * POST /scenes/:sceneId/ai/apply — re-validates the plan against a
 * fresh document snapshot, then applies it through the existing
 * domain mutations. No autonomous loops, no direct DB writes here.
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
};
