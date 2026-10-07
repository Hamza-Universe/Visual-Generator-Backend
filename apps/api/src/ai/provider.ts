import { z } from 'zod';
import { AppError } from '../errors.js';

/**
 * AI model provider abstraction (Stage 4A).
 *
 * The application depends on `AISceneProvider`, never on OpenRouter
 * directly, so changing OPENROUTER_MODEL (or adding a future provider)
 * requires no application-code changes.
 */

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface AIModelConfig {
  provider: 'openrouter';
  model: string;
  supportsStructuredOutput?: boolean;
  supportsToolCalling?: boolean;
  contextWindow?: number;
}

export const resolveAIModelConfig = (input: {
  model?: string;
}): AIModelConfig => ({
  provider: 'openrouter',
  model: input.model && input.model.length > 0 ? input.model : 'openrouter/free',
});

export interface AIStructuredRequest {
  system: string;
  user: string;
  /** Label used in error messages when validation fails. */
  schemaName: string;
}

export interface AIStructuredResult<T> {
  data: T;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface AISceneProvider {
  readonly provider: 'openrouter';
  readonly model: string;
  generateStructured<T>(
    request: AIStructuredRequest,
    schema: z.ZodType<T>,
  ): Promise<AIStructuredResult<T>>;
}

type FetchImpl = typeof fetch;

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string };
}

/** Strip ```json fences so fenced model output still parses. */
export const extractJsonText = (content: string): string => {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? trimmed).trim();
};

export class OpenRouterProvider implements AISceneProvider {
  readonly provider = 'openrouter' as const;

  constructor(
    readonly model: string,
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      fetchImpl?: FetchImpl;
    },
  ) {
    if (!options.apiKey) {
      throw new AppError(
        'AI_MODEL_UNAVAILABLE',
        'AI model is not configured (missing API key)',
        503,
      );
    }
    if (!model) {
      throw new AppError('AI_MODEL_UNAVAILABLE', 'AI model is not configured', 503);
    }
  }

  async generateStructured<T>(
    request: AIStructuredRequest,
    schema: z.ZodType<T>,
  ): Promise<AIStructuredResult<T>> {
    const baseUrl =
      this.options.baseUrl && this.options.baseUrl.length > 0
        ? this.options.baseUrl
        : OPENROUTER_DEFAULT_BASE_URL;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            response_format: { type: 'json_object' },
          }),
        },
      );
    } catch (error) {
      throw new AppError(
        'AI_PROVIDER_ERROR',
        `AI provider request failed: ${error instanceof Error ? error.message : 'network error'}`,
        502,
      );
    }
    if (!response.ok) {
      throw new AppError(
        'AI_PROVIDER_ERROR',
        `AI provider returned HTTP ${response.status}`,
        502,
      );
    }
    let body: OpenRouterChatResponse;
    try {
      body = (await response.json()) as OpenRouterChatResponse;
    } catch {
      throw new AppError('AI_INVALID_RESPONSE', 'AI provider returned unreadable JSON', 502);
    }
    if (body.error?.message) {
      throw new AppError('AI_PROVIDER_ERROR', `AI provider error: ${body.error.message}`, 502);
    }
    const content = body.choices?.[0]?.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                typeof part === 'string'
                  ? part
                  : typeof part === 'object' && part !== null && 'text' in part
                    ? String((part as { text?: unknown }).text ?? '')
                    : '',
              )
              .join('')
          : '';
    if (!text.trim()) {
      throw new AppError('AI_INVALID_RESPONSE', 'AI provider returned empty content', 502);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonText(text)) as unknown;
    } catch {
      throw new AppError('AI_INVALID_RESPONSE', 'AI provider returned invalid JSON', 502);
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new AppError(
        'AI_SCHEMA_ERROR',
        `AI response did not match ${request.schemaName}`,
        502,
        validated.error.issues,
      );
    }
    return {
      data: validated.data,
      latencyMs: Date.now() - startedAt,
      ...(body.usage
        ? {
            usage: {
              promptTokens: body.usage.prompt_tokens,
              completionTokens: body.usage.completion_tokens,
              totalTokens: body.usage.total_tokens,
            },
          }
        : {}),
    };
  }
}

export const createSceneAIProvider = (input: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): AISceneProvider => {
  const config = resolveAIModelConfig({ model: input.model });
  return new OpenRouterProvider(config.model, {
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });
};
