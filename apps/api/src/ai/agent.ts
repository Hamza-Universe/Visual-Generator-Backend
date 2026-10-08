import { z } from 'zod';
import type { SceneDocument } from '@app/schema';
import type { Database } from '@app/db';
import { AppError } from '../errors.js';
import {
  AIScenePlanSchema,
  MAX_AI_PLAN_OPERATIONS,
  type AIScenePlan,
} from './operations.js';
import { buildAIContext, type AIContextInput } from './context.js';
import type { AISceneProvider, AIStructuredResult } from './provider.js';
import { listDefinitionsForAI } from './registry.js';
import {
  applyScenePlan,
  fetchSceneDocument,
  validateScenePlan,
  type AIPlanDefinition,
  type PlanIssue,
} from './apply.js';
import {
  AIAgentVerificationSchema,
  verifySceneExpectations,
  type AIAgentVerificationOutcome,
} from './verification.js';
import { AGENT_TOOL_SPECS, executeAgentTool } from './tools.js';
import {
  AI_AGENT_CONTEXT_VERSION,
  AGENT_SCENE_INSTRUCTIONS,
  SCENE_AGENT_SYSTEM_PROMPT_V1,
} from './systemPrompt.js';

/**
 * Bounded agentic scene editing (Stage 4B).
 *
 * One request runs a small, application-owned loop:
 *
 *   inspect (allowlisted read tools) → structured plan → full validation →
 *   existing domain application → deterministic verification → bounded
 *   correction, up to `maxIterations`.
 *
 * The model is still an untrusted planner: it cannot terminate the loop by
 * itself, cannot expand budgets, cannot execute code, and cannot mutate
 * anything except through the Stage 4A plan/apply path. The application
 * owns iteration count, tool budget, operation budget, context size, and
 * execution time. Agent state lives only for the duration of the request —
 * nothing is persisted, no background agent exists.
 */

// ---------------------------------------------------------------------------
// Limits (application-controlled; never accepted from model or frontend)
// ---------------------------------------------------------------------------

export interface AIAgentLimits {
  /** Hard iteration cap for the inspect → plan → apply → verify loop. */
  maxIterations: number;
  /** Total read-tool calls allowed across the whole request. */
  toolCallBudget: number;
  /** Total operations allowed across all applied plans in this request. */
  operationBudget: number;
  /** Wall-clock budget for the whole agent request. */
  timeoutMs: number;
  /** Model turns per iteration (each tool round costs one turn). */
  turnsPerIteration: number;
  /** Bounded retries for schema-invalid model responses. */
  schemaRetryBudget: number;
  /** Failed tool calls tolerated before terminating with tool_error. */
  toolErrorBudget: number;
}

export const DEFAULT_AGENT_LIMITS: AIAgentLimits = {
  maxIterations: 3,
  toolCallBudget: 16,
  operationBudget: 100,
  timeoutMs: 60_000,
  turnsPerIteration: 6,
  schemaRetryBudget: 2,
  toolErrorBudget: 5,
};

const clampNumber = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(max, Math.max(min, Math.floor(value)));

export const resolveAgentLimits = (
  input: Partial<AIAgentLimits> = {},
): AIAgentLimits => ({
  maxIterations: clampNumber(input.maxIterations, DEFAULT_AGENT_LIMITS.maxIterations, 1, 5),
  toolCallBudget: clampNumber(input.toolCallBudget, DEFAULT_AGENT_LIMITS.toolCallBudget, 0, 64),
  operationBudget: clampNumber(input.operationBudget, DEFAULT_AGENT_LIMITS.operationBudget, 1, 500),
  timeoutMs: clampNumber(input.timeoutMs, DEFAULT_AGENT_LIMITS.timeoutMs, 0, 300_000),
  turnsPerIteration: clampNumber(
    input.turnsPerIteration,
    DEFAULT_AGENT_LIMITS.turnsPerIteration,
    1,
    12,
  ),
  schemaRetryBudget: clampNumber(input.schemaRetryBudget, DEFAULT_AGENT_LIMITS.schemaRetryBudget, 0, 5),
  toolErrorBudget: clampNumber(input.toolErrorBudget, DEFAULT_AGENT_LIMITS.toolErrorBudget, 1, 20),
});

/** Tool calls allowed in a single model response. */
export const MAX_TOOL_CALLS_PER_TURN = 6;
/** Observations carried into one context message. */
export const MAX_CONTEXT_OBSERVATIONS = 8;
export const MAX_CONTEXT_FEEDBACK_ISSUES = 10;

// ---------------------------------------------------------------------------
// Model response contract
// ---------------------------------------------------------------------------

export const AIAgentToolCallSchema = z.object({
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

/**
 * One model turn is either an inspection (toolCalls) or a decision
 * (plan/done + mandatory verification). The provider validates every
 * response against this schema before the harness sees it.
 */
export const AIAgentTurnSchema = z
  .object({
    toolCalls: z.array(AIAgentToolCallSchema).max(MAX_TOOL_CALLS_PER_TURN).default([]),
    plan: AIScenePlanSchema.optional(),
    done: z.boolean().default(false),
    verification: AIAgentVerificationSchema.optional(),
  })
  .superRefine((turn, ctx) => {
    if (turn.toolCalls.length > 0) return;
    if (!turn.verification) {
      ctx.addIssue({
        code: 'custom',
        path: ['verification'],
        message: 'verification is required with a plan or done response',
      });
    }
    const hasPlan = (turn.plan?.operations.length ?? 0) > 0;
    if (!hasPlan && !turn.done) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan'],
        message: 'send toolCalls, a non-empty plan, or done=true',
      });
    }
  });

export type AIAgentTurn = z.infer<typeof AIAgentTurnSchema>;

// ---------------------------------------------------------------------------
// Internal per-request state (never persisted)
// ---------------------------------------------------------------------------

export interface AIAgentObservation {
  tool: string;
  args: string;
  result?: unknown;
  error?: string;
}

type AgentFeedback =
  | { kind: 'validation'; issues: PlanIssue[] }
  | { kind: 'verification'; issues: string[] }
  | { kind: 'schema'; message: string };

interface IterationSummary {
  iteration: number;
  planOperations: number;
  applied: Array<{ type: string; id: string | null }>;
  verification: AIAgentVerificationOutcome | null;
}

export type AIAgentStatus =
  | 'completed'
  | 'max_iterations'
  | 'validation_failed'
  | 'tool_error'
  | 'provider_error'
  | 'application_error'
  | 'unauthorized'
  | 'timeout';

export interface AIAgentAppliedOperation {
  iteration: number;
  index: number;
  type: string;
  id: string | null;
}

export interface AIAgentResult {
  status: AIAgentStatus;
  iterations: number;
  toolCalls: number;
  modelCalls: number;
  plans: AIScenePlan[];
  appliedOperations: AIAgentAppliedOperation[];
  /** Last verification evaluated by the application (null when none ran). */
  verification: AIAgentVerificationOutcome | null;
  failure?: { code: string; message: string };
  /** Fresh document snapshot after the last applied plan (for refresh). */
  document: SceneDocument;
  meta: {
    provider: string;
    model: string;
    contextVersion: string;
    latencyMs: number;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Context construction (bounded, targeted)
// ---------------------------------------------------------------------------

const boundedJson = (value: unknown, maxLength: number): string => {
  try {
    const json = JSON.stringify(value) ?? '';
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return '{}';
  }
};

const boundedMessage = (value: string, maxLength = 300): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;

const REPLY_FORMAT = [
  'Reply with exactly ONE JSON object in one of three shapes:',
  '{"toolCalls": [{"name": "...", "args": {...}}]} — inspect only; allowed names: getScene, findInstances, getInstance, getInstanceBounds, findOverlaps.',
  '{"plan": {"operations": [...]}, "verification": {...}} — change the scene, then state how success is measured.',
  '{"done": true, "verification": {...}} — the objective is already satisfied; state the checks that prove it.',
  'Do not combine toolCalls with a plan in one reply: inspect first, then decide.',
  `verification requires at least one check: instances (existence, optional expectPosition {x?, y?} / expectSize {width?, height?}), noOverlap, noOverlapWithScene, overlapPairs, or references.`,
].join('\n');

export interface AIAgentMessageInput {
  prompt: string;
  selection?: { instanceIds?: string[] };
  document: SceneDocument;
  definitions: AIContextInput['definitions'];
  userId: string;
  iteration: number;
  turn: number;
  limits: AIAgentLimits;
  toolCallsUsed: number;
  operationsApplied: number;
  observations: AIAgentObservation[];
  feedback: AgentFeedback | null;
  priorIterations: IterationSummary[];
  createdObjects: Array<{ kind: string; clientKey: string; id: string }>;
}

/**
 * One bounded context message: the Stage 4A scene pack (unchanged caps)
 * plus the agent overlay (budgets, tools, observations, prior iterations,
 * feedback). Never repository source, never DB internals, never secrets.
 */
export const buildAgentUserMessage = (input: AIAgentMessageInput): string => {
  const scene = {
    ...buildAIContext({
      document: input.document,
      definitions: input.definitions,
      userId: input.userId,
      ...(input.selection ? { selection: input.selection } : {}),
    }),
    instructions: AGENT_SCENE_INSTRUCTIONS,
  };
  return JSON.stringify({
    agent: {
      version: AI_AGENT_CONTEXT_VERSION,
      iteration: input.iteration,
      maxIterations: input.limits.maxIterations,
      turn: input.turn,
      turnsPerIteration: input.limits.turnsPerIteration,
      budgets: {
        toolCalls: {
          used: input.toolCallsUsed,
          max: input.limits.toolCallBudget,
        },
        operations: {
          applied: input.operationsApplied,
          max: input.limits.operationBudget,
        },
        planOperations: { max: MAX_AI_PLAN_OPERATIONS },
      },
      tools: AGENT_TOOL_SPECS.map((spec) => ({
        name: spec.name,
        description: spec.description,
        args: spec.args,
      })),
      createdThisRequest: input.createdObjects,
      priorIterations: input.priorIterations,
      feedback: input.feedback,
      observations: input.observations.slice(-MAX_CONTEXT_OBSERVATIONS),
    },
    scene,
    userRequest: input.prompt,
    replyWith: REPLY_FORMAT,
  });
};

// ---------------------------------------------------------------------------
// The bounded loop
// ---------------------------------------------------------------------------

export const runSceneAgent = async (input: {
  db: Database;
  sceneId: string;
  userId: string;
  prompt: string;
  selection?: { instanceIds?: string[] };
  provider: AISceneProvider;
  /** Pre-fetched + authorized document (avoids a second authorization). */
  document?: SceneDocument;
  /** Pre-loaded authorized definitions; loaded from the DB when omitted. */
  definitions?: AIContextInput['definitions'];
  limits?: Partial<AIAgentLimits>;
}): Promise<AIAgentResult> => {
  const limits = resolveAgentLimits(input.limits);
  const startedAt = Date.now();
  const deadline = startedAt + limits.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

  try {
    const document =
      input.document ?? (await fetchSceneDocument(input.db, input.sceneId, input.userId));
    const definitions =
      input.definitions ?? (await listDefinitionsForAI(input.db, input.userId));

    const plans: AIScenePlan[] = [];
    const appliedOperations: AIAgentAppliedOperation[] = [];
    const iterationSummaries: IterationSummary[] = [];
    const createdObjects: Array<{ kind: string; clientKey: string; id: string }> = [];
    /** Request-scoped clientKey → id; enables idempotent bounded retries. */
    const usedClientKeys = new Map<string, string>();

    let currentDocument = document;
    let iterationsRun = 0;
    let toolCallsUsed = 0;
    let toolErrors = 0;
    let modelCalls = 0;
    let schemaRetries = 0;
    let operationsApplied = 0;
    let status: AIAgentStatus | null = null;
    let failure: { code: string; message: string } | undefined;
    let verification: AIAgentVerificationOutcome | null = null;
    let feedback: AgentFeedback | null = null;
    let lastOutcome: 'validation' | 'verification' | null = null;
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    const addUsage = (next: typeof usage): void => {
      if (!next) return;
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + (next.promptTokens ?? 0),
        completionTokens: (usage?.completionTokens ?? 0) + (next.completionTokens ?? 0),
        totalTokens: (usage?.totalTokens ?? 0) + (next.totalTokens ?? 0),
      };
    };

    for (
      let iteration = 1;
      iteration <= limits.maxIterations && status === null;
      iteration++
    ) {
      iterationsRun = iteration;
      const observations: AIAgentObservation[] = [];
      let decision: AIAgentTurn | null = null;

      // -- turn loop: inspect (bounded), then decide ----------------------
      for (let turn = 1; turn <= limits.turnsPerIteration && decision === null; turn++) {
        if (Date.now() >= deadline) {
          status = 'timeout';
          failure = {
            code: 'AI_TIMEOUT',
            message: 'Agent request exceeded its execution time budget',
          };
          break;
        }
        const user = buildAgentUserMessage({
          prompt: input.prompt,
          ...(input.selection ? { selection: input.selection } : {}),
          document: currentDocument,
          definitions,
          userId: input.userId,
          iteration,
          turn,
          limits,
          toolCallsUsed,
          operationsApplied,
          observations,
          feedback,
          priorIterations: iterationSummaries,
          createdObjects,
        });
        modelCalls += 1;
        let response: AIStructuredResult<AIAgentTurn>;
        try {
          response = await input.provider.generateStructured(
            {
              system: SCENE_AGENT_SYSTEM_PROMPT_V1,
              user,
              schemaName: 'AIAgentTurn',
            },
            AIAgentTurnSchema,
            { signal: controller.signal },
          );
        } catch (error) {
          if (Date.now() >= deadline) {
            status = 'timeout';
            failure = {
              code: 'AI_TIMEOUT',
              message: 'Agent request exceeded its execution time budget',
            };
            break;
          }
          const code = error instanceof AppError ? error.code : 'AI_PROVIDER_ERROR';
          if (
            error instanceof AppError &&
            (code === 'AI_SCHEMA_ERROR' || code === 'AI_INVALID_RESPONSE')
          ) {
            // Model/plan failure: bounded correction with feedback that
            // carries the exact contract violations back to the model.
            schemaRetries += 1;
            if (schemaRetries > limits.schemaRetryBudget) {
              status = 'validation_failed';
              failure = { code, message: boundedMessage(error.message) };
              break;
            }
            const detailText =
              Array.isArray(error.details) && error.details.length > 0
                ? `${error.message}: ${boundedJson(error.details.slice(0, 3), 400)}`
                : error.message;
            feedback = { kind: 'schema', message: boundedMessage(detailText, 500) };
            continue;
          }
          // Provider/runtime failure: stop safely, never retry blindly.
          status = 'provider_error';
          failure = {
            code,
            message: boundedMessage(
              error instanceof Error ? error.message : 'AI provider request failed',
            ),
          };
          break;
        }
        addUsage(response.usage);
        const turnResult = response.data;

        if (turnResult.toolCalls.length > 0) {
          if (toolCallsUsed >= limits.toolCallBudget) {
            status = 'tool_error';
            failure = {
              code: 'AI_TOOL_BUDGET_EXCEEDED',
              message: `Tool call budget exhausted (${limits.toolCallBudget} calls); propose a plan or done`,
            };
            break;
          }
          const remaining = limits.toolCallBudget - toolCallsUsed;
          const selected = turnResult.toolCalls.slice(0, remaining);
          if (turnResult.toolCalls.length > selected.length) {
            observations.push({
              tool: '(harness)',
              args: '{}',
              error: `Only ${remaining} tool call(s) remain in the budget; the rest were not executed. Reply with a plan or done next.`,
            });
          }
          if (turnResult.plan || turnResult.done) {
            observations.push({
              tool: '(harness)',
              args: '{}',
              result: {
                note: 'Inspection results come first: the plan/done in this response was ignored. Review the observations, then reply with plan + verification (or done) in a separate response.',
              },
            });
          }
          for (const call of selected) {
            toolCallsUsed += 1;
            const outcome = executeAgentTool({
              name: call.name,
              args: call.args,
              document: currentDocument,
            });
            const args = boundedJson(call.args, 300);
            if (outcome.ok) {
              observations.push({ tool: call.name, args, result: outcome.result });
            } else {
              toolErrors += 1;
              observations.push({ tool: call.name, args, error: outcome.message });
            }
          }
          if (toolErrors > limits.toolErrorBudget) {
            status = 'tool_error';
            failure = {
              code: 'AI_TOOL_ERROR',
              message: `Too many failed tool calls (${toolErrors} of ${limits.toolErrorBudget} tolerated)`,
            };
            break;
          }
          continue;
        }
        decision = turnResult;
      }

      if (status !== null) break;
      if (!decision) {
        status = 'tool_error';
        failure = {
          code: 'AI_TURN_LIMIT',
          message: `No plan or done decision after ${limits.turnsPerIteration} inspection turns`,
        };
        break;
      }

      // -- decision: validate → apply (the Stage 4A path) -----------------
      const plan =
        decision.plan && decision.plan.operations.length > 0 ? decision.plan : null;
      const planOperations = plan ? plan.operations.length : 0;
      const iterationApplied: Array<{ type: string; id: string | null }> = [];

      if (plan) {
        plans.push(plan);
        if (operationsApplied + plan.operations.length > limits.operationBudget) {
          feedback = {
            kind: 'validation',
            issues: [
              {
                opIndex: -1,
                path: 'operations',
                code: 'AI_OPERATION_BUDGET',
                message: `Operation budget exhausted: ${operationsApplied} of ${limits.operationBudget} operations already applied in this request`,
              },
            ],
          };
          lastOutcome = 'validation';
          iterationSummaries.push({
            iteration,
            planOperations,
            applied: [],
            verification: null,
          });
          continue;
        }
        const issues = validateScenePlan({
          document: currentDocument,
          definitions,
          plan,
          usedClientKeys,
        });
        if (issues.length > 0) {
          feedback = { kind: 'validation', issues };
          lastOutcome = 'validation';
          iterationSummaries.push({
            iteration,
            planOperations,
            applied: [],
            verification: null,
          });
          continue;
        }

        let applied;
        try {
          applied = await applyScenePlan({
            db: input.db,
            sceneId: input.sceneId,
            userId: input.userId,
            definitions,
            plan,
            usedClientKeys,
          });
        } catch (error) {
          if (error instanceof AppError && error.code === 'FORBIDDEN') {
            status = 'unauthorized';
            failure = { code: error.code, message: boundedMessage(error.message) };
            break;
          }
          if (
            error instanceof AppError &&
            error.statusCode < 500 &&
            (error.code === 'AI_OPERATION_INVALID' || error.code === 'NOT_FOUND')
          ) {
            // Deterministic domain rejection: bounded correction, no writes.
            const detailIssues =
              Array.isArray(error.details) && error.details.length > 0
                ? (error.details as PlanIssue[])
                : [
                    {
                      opIndex: -1,
                      path: 'plan',
                      code: error.code,
                      message: boundedMessage(error.message),
                    },
                  ];
            feedback = { kind: 'validation', issues: detailIssues };
            lastOutcome = 'validation';
            iterationSummaries.push({
              iteration,
              planOperations,
              applied: [],
              verification: null,
            });
            continue;
          }
          // Runtime/application failure: stop. Never repeat a write after an
          // ambiguous failure — the outcome on the server is unknown.
          status = 'application_error';
          failure = {
            code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
            message: boundedMessage(
              error instanceof Error ? error.message : 'Application failed mid-run',
            ),
          };
          break;
        }

        operationsApplied += applied.applied.length;
        for (const item of applied.applied) {
          appliedOperations.push({ iteration, ...item });
          iterationApplied.push({ type: item.type, id: item.id });
          const op = plan.operations[item.index];
          if (
            (op?.type === 'createInstance' || op?.type === 'createGroup') &&
            op.clientKey &&
            item.id
          ) {
            usedClientKeys.set(op.clientKey, item.id);
            createdObjects.push({
              kind: op.type === 'createInstance' ? 'instance' : 'group',
              clientKey: op.clientKey,
              id: item.id,
            });
          }
        }
        currentDocument = applied.document;
        feedback = null;
        lastOutcome = null;
      }

      // -- verification: application-side, deterministic -------------------
      if (!decision.verification) {
        status = 'validation_failed';
        failure = {
          code: 'AI_SCHEMA_ERROR',
          message: 'Model response omitted verification expectations',
        };
        break;
      }
      verification = verifySceneExpectations({
        document: currentDocument,
        expectations: decision.verification,
        clientKeyMap: usedClientKeys,
      });
      iterationSummaries.push({
        iteration,
        planOperations,
        applied: iterationApplied,
        verification,
      });
      if (verification.passed) {
        status = 'completed';
        break;
      }
      lastOutcome = 'verification';
      feedback = { kind: 'verification', issues: verification.issues };
    }

    const finalStatus: AIAgentStatus =
      status ?? (lastOutcome === 'validation' ? 'validation_failed' : 'max_iterations');

    return {
      status: finalStatus,
      iterations: iterationsRun,
      toolCalls: toolCallsUsed,
      modelCalls,
      plans,
      appliedOperations,
      verification,
      ...(failure ? { failure } : {}),
      document: currentDocument,
      meta: {
        provider: input.provider.provider,
        model: input.provider.model,
        contextVersion: AI_AGENT_CONTEXT_VERSION,
        latencyMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
      },
    };
  } finally {
    clearTimeout(timer);
  }
};
