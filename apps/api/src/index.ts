import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { createDb } from '@app/db';
import { loadConfig } from './config.js';
import { registerErrorHandler } from './errors.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerComponentRoutes } from './routes/components.js';
import { registerAssetRoutes } from './routes/assets.js';
import { LocalStorage } from '@app/storage';
import { registerTranscriptRoutes } from './routes/transcripts.js';
import { registerRenderRoutes } from './routes/renders.js';
import { checkFfmpeg, GeminiTranscriptionProvider } from './services/transcription.js';
import { registerGenerateRoute } from './routes/generate.js';
import { AuthService } from './services/auth.js';
import { registerAuthRoutes, requireAuth } from './routes/auth.js';
import { registerSceneRoutes } from './routes/scenes.js';
import { registerAIRoutes } from './routes/ai.js';
import { EmailService } from './services/email.js';

loadDotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
});

export const buildApp = (config = loadConfig()) => {
  const app = Fastify({ logger: true });
  void checkFfmpeg(app.log);
  const db = createDb(config.DATABASE_URL);
  const storage = new LocalStorage(config.STORAGE_DIR);
  const auth = new AuthService({
    jwtSecret: config.JWT_SECRET,
    tokenTtlSeconds: config.JWT_TTL_SECONDS,
    passwordMinLength: 12,
  });
  const email = new EmailService({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    user: config.SMTP_USER,
    password: config.SMTP_PASSWORD,
    from: config.SMTP_FROM ?? '',
    resetUrl: config.PASSWORD_RESET_URL,
  });
  registerRenderRoutes;

  app.addHook('preHandler', async (request) => {
    const path = request.raw.url ?? '/';
    if (
      request.method === 'OPTIONS' ||
      path === '/health' ||
      path.startsWith('/auth') ||
      path.includes('/public-file/')
    ) {
      return;
    }

    const user = await requireAuth({
      request,
      db,
      jwtSecret: config.JWT_SECRET,
    });
    request.user = user;
  });

  app.register(cors, { origin: config.CORS_ORIGIN });
  app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  });
  app.get('/health', async (_request, reply) => {
    await db.execute('select 1');
    return reply.send({ ok: true });
  });
  registerAuthRoutes(app, db, auth, email);
  registerProjectRoutes(app, db);
  registerSceneRoutes(app, db);
  registerComponentRoutes(app, db);
  registerAssetRoutes(app, db, storage, config.MAX_UPLOAD_MB, config.API_BASE_URL);
  registerTranscriptRoutes(
    app,
    db,
    new GeminiTranscriptionProvider(config.GEMINI_API_KEY),
    storage,
  );
  registerGenerateRoute(app, db, {
    provider: config.AI_PROVIDER,
    apiKey: config.GEMINI_API_KEY,
    model: config.AI_MODEL,
  });
  registerRenderRoutes(app, db, config.REDIS_URL, storage, {
    attempts: config.RENDER_ATTEMPTS,
    backoffMs: config.RENDER_BACKOFF_MS,
  });
  registerAIRoutes(app, db, {
    apiKey: config.OPENROUTER_API_KEY,
    model: config.OPENROUTER_MODEL,
    baseUrl: config.OPENROUTER_BASE_URL,
  });
  registerErrorHandler(app);
  return app;
};
if (process.env.NODE_ENV !== 'test') {
  const config = loadConfig();
  buildApp(config)
    .listen({ port: config.PORT, host: '0.0.0.0' })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
