import { z } from 'zod';
import {
  DEFAULT_RENDER_ATTEMPTS,
  DEFAULT_RENDER_BACKOFF_MS,
} from '@app/schema';
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STORAGE_DIR: z.string().min(1),
  /**
   * Stage 3H producer retry policy (BullMQ job options set at enqueue).
   * Genuinely transient failures (browser/encode crashes, timeouts under
   * load, storage/DB blips) retry with exponential backoff; deterministic
   * validation failures fail fast via UnrecoverableError in the worker.
   */
  RENDER_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(
    DEFAULT_RENDER_ATTEMPTS,
  ),
  RENDER_BACKOFF_MS: z.coerce.number().int().positive().default(
    DEFAULT_RENDER_BACKOFF_MS,
  ),
  GEMINI_API_KEY: z.string().optional().default(''),
  AI_PROVIDER: z.enum(['manual', 'gemini']).default('manual'),
  AI_MODEL: z.string().optional().default('gemini-3.8-flash'),
  /**
   * Stage 4A scene-authoring AI (OpenRouter). Server-side only — never
   * exposed to the frontend. The model is configurable via environment;
   * changing it requires no application-code changes.
   */
  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_MODEL: z.string().optional().default('openrouter/free'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  /**
   * Stage 4B bounded agent budgets. Application-owned: never accepted from
   * the frontend and never expandable by the model.
   */
  AI_AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(5).default(3),
  AI_AGENT_TOOL_BUDGET: z.coerce.number().int().min(0).max(64).default(16),
  AI_AGENT_OPERATION_BUDGET: z.coerce.number().int().min(1).max(500).default(100),
  AI_AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(500),
  API_BASE_URL: z.string().url().default('http://localhost:3001'),
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  JWT_SECRET: z
    .string()
    .min(32)
    .default('change-me-in-production-please-keep-long'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().email().or(z.literal('')).optional(),
  PASSWORD_RESET_URL: z
    .string()
    .url()
    .default('http://localhost:5173/reset-password'),
});
export type Config = z.infer<typeof EnvSchema>;
export const loadConfig = (): Config => {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      'Invalid environment configuration',
      result.error.flatten().fieldErrors,
    );
    process.exit(1);
  }
  return result.data;
};
