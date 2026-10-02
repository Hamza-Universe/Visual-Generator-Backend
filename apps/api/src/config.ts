import { z } from 'zod';
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STORAGE_DIR: z.string().min(1),
  GEMINI_API_KEY: z.string().optional().default(''),
  AI_PROVIDER: z.enum(['manual', 'gemini']).default('manual'),
  AI_MODEL: z.string().optional().default('gemini-2.0-flash'),
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
