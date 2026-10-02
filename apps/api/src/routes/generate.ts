import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assets, projects, transcripts } from '@app/db';
import type { Database } from '@app/db';
import { AppError, sendError } from '../errors.js';
import { createAIProvider } from '../services/ai/index.js';
import { ManualProvider } from '../services/ai/manual.js';
import { buildCatalog, buildTranscript } from '../services/ai/provider.js';
import {
  loadGenerationContext,
  parseGeneratedSpec,
  preserveProjectSettings,
} from '../services/ai/validation.js';
import { VideoSpecSchema } from '@app/schema';

const generateSchema = z.object({
  transcriptId: z.string().uuid(),
  instructions: z.string().max(20_000).optional(),
  save: z.boolean().optional(),
  provider: z.enum(['gemini', 'manual']).optional(),
  apiKey: z.string().min(1).max(500).optional(),
  model: z.string().min(1).max(200).optional(),
});
const manualPromptSchema = z.object({
  transcriptId: z.string().uuid(),
  instructions: z.string().max(20_000).optional(),
});
const manualSubmitSchema = z.object({
  transcriptId: z.string().uuid(),
  rawResponse: z.string().min(1).max(2_000_000),
  save: z.boolean().optional(),
});
const balancedJson = (raw: string) => {
  const text = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = text.indexOf('{');
  if (start < 0)
    throw new AppError(
      'MALFORMED_RESPONSE',
      'No JSON object found in response',
    );
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '{') depth += 1;
    if (!quoted && character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new AppError(
    'MALFORMED_RESPONSE',
    'Unbalanced JSON object in response',
  );
};
export const registerGenerateRoute = (
  app: FastifyInstance,
  db: Database,
  defaults: {
    provider: string;
    apiKey: string;
    model: string;
  },
) => {
  const load = async (
    id: string,
    transcriptId: string | undefined,
    userId: string,
  ) => {
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)));
    const [transcript] = transcriptId
      ? await db
          .select({ transcript: transcripts, asset: assets })
          .from(transcripts)
          .innerJoin(assets, eq(transcripts.assetId, assets.id))
          .where(
            and(eq(transcripts.id, transcriptId), eq(assets.userId, userId)),
          )
      : [];
    if (!project || !transcript)
      throw new AppError('NOT_FOUND', 'Project or transcript not found', 404);
    const generation = await loadGenerationContext(
      db,
      project.maxComponents,
      userId,
    );
    return {
      project,
      transcript: transcript.transcript,
      generation,
      audioKind: transcript.asset.kind,
    };
  };
  const finish = async (input: {
    project: typeof projects.$inferSelect;
    raw: unknown;
    generation: Awaited<ReturnType<typeof loadGenerationContext>>;
    audioAssetId?: string;
    save?: boolean;
  }) => {
    const parsed = parseGeneratedSpec(input.raw, input.generation.context);
    if (!parsed.spec)
      throw new AppError(
        'INVALID_GENERATION',
        'Generated spec failed validation',
        422,
        parsed.issues,
      );
    const current = VideoSpecSchema.parse(input.project.spec);
    const spec = preserveProjectSettings(
      parsed.spec,
      current,
      input.audioAssetId,
    );
    const final = parseGeneratedSpec(spec, input.generation.context);
    if (!final.spec)
      throw new AppError(
        'INVALID_GENERATION',
        'Generated spec failed validation',
        422,
        final.issues,
      );
    if (input.save !== false)
      await db
        .update(projects)
        .set({ spec: final.spec, updatedAt: new Date() })
        .where(eq(projects.id, input.project.id));
    return { spec: final.spec, issues: [], attempts: 1 };
  };
  app.post('/projects/:id/generate', async (request, reply) => {
    try {
      const parsedInput = generateSchema.safeParse(request.body);
      if (!parsedInput.success)
        throw new AppError(
          'BAD_INPUT',
          'Invalid generation payload',
          400,
          parsedInput.error.issues,
        );
      const input = parsedInput.data;
      const loaded = await load(
        (request.params as { id: string }).id,
        input.transcriptId,
        request.user!.id,
      );
      const providerName = input.provider ?? defaults.provider;
      const key = input.apiKey ?? defaults.apiKey;
      const model = input.model ?? defaults.model;
      if (!key || !model || providerName === 'manual')
        throw new AppError(
          'MISSING_CONFIG',
          'An AI provider key and model are required; use manual-prompt for keyless generation',
          500,
        );
      const provider = createAIProvider({
        provider: providerName,
        apiKey: key,
        model,
      });
      const catalog = buildCatalog(loaded.generation.rows as never);
      const transcript = buildTranscript(loaded.transcript as never);
      let previous: { spec: unknown; issues: never[] } | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const raw = await provider.generate({
          system: '',
          catalog,
          theme: JSON.stringify(
            (loaded.project.spec as { theme: unknown }).theme,
          ),
          transcript,
          instructions: input.instructions,
          previousAttempt: previous,
        });
        const parsed = parseGeneratedSpec(raw, loaded.generation.context);
        if (parsed.spec)
          return reply.send(
            await finish({
              project: loaded.project,
              raw,
              generation: loaded.generation,
              audioAssetId: ['audio', 'video'].includes(loaded.audioKind ?? '')
                ? loaded.transcript.assetId
                : undefined,
              save: input.save,
            }),
          );
        previous = { spec: raw, issues: parsed.issues as never[] };
      }
      throw new AppError(
        'INVALID_GENERATION',
        'Generated spec failed validation',
        422,
        previous?.issues ?? [],
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/projects/:id/generate/manual-prompt', async (request, reply) => {
    try {
      const parsedInput = manualPromptSchema.safeParse(request.body);
      if (!parsedInput.success)
        throw new AppError(
          'BAD_INPUT',
          'Invalid manual prompt payload',
          400,
          parsedInput.error.issues,
        );
      const input = parsedInput.data;
      const loaded = await load(
        (request.params as { id: string }).id,
        input.transcriptId,
        request.user!.id,
      );
      const promptText = new ManualProvider().buildPromptText({
        components: loaded.generation.rows as never,
        theme: VideoSpecSchema.parse(loaded.project.spec).theme,
        transcript: loaded.transcript as never,
        instructions: input.instructions,
        maxComponents: loaded.project.maxComponents,
      });
      return reply.send({ promptText });
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/projects/:id/generate/manual-submit', async (request, reply) => {
    try {
      const parsedInput = manualSubmitSchema.safeParse(request.body);
      if (!parsedInput.success)
        throw new AppError(
          'BAD_INPUT',
          'Invalid manual submit payload',
          400,
          parsedInput.error.issues,
        );
      const input = parsedInput.data;
      const loaded = await load(
        (request.params as { id: string }).id,
        input.transcriptId,
        request.user!.id,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(balancedJson(input.rawResponse));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          'MALFORMED_RESPONSE',
          error instanceof Error ? error.message : 'Response is not valid JSON',
        );
      }
      return reply.send(
        await finish({
          project: loaded.project,
          raw,
          generation: loaded.generation,
          audioAssetId: ['audio', 'video'].includes(loaded.audioKind ?? '')
            ? loaded.transcript.assetId
            : undefined,
          save: input.save,
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
