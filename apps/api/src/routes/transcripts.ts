import { and, eq, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { assets, transcripts } from '@app/db';
import type { Database } from '@app/db';
import { AppError, sendError } from '../errors.js';
import type { TranscriptionProvider } from '../services/transcription.js';
import { LocalStorage } from '@app/storage';
import { TranscriptSchema } from '@app/schema';
export const registerTranscriptRoutes = (
  app: FastifyInstance,
  db: Database,
  provider: TranscriptionProvider,
  storage: LocalStorage,
) => {
  app.post('/assets/:id/transcribe', async (request, reply) => {
    try {
      const id = (request.params as { id: string }).id;
      const projectId = (request.query as { projectId?: string }).projectId;
      const conditions = [eq(assets.id, id), eq(assets.userId, request.user!.id)];
      if (projectId) conditions.push(eq(assets.projectId, projectId));
      const [asset] = await db
        .select()
        .from(assets)
        .where(and(...conditions));
      if (!asset || !['audio', 'video'].includes(asset.kind))
        throw new AppError('BAD_INPUT', 'Asset must be audio or video');
      const result = await provider.transcribe({
        filePath: storage.path(asset.storageKey),
        mimeType: asset.mimeType,
        language: (request.body as { language?: string } | undefined)?.language,
      });
      const [row] = await db
        .insert(transcripts)
        .values({
          assetId: id,
          language: result.language,
          text: result.text,
          words: result.words,
          durationSeconds: result.durationSeconds,
        })
        .returning();
      return reply.code(201).send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.post('/assets/:id/transcripts/import', async (request, reply) => {
    try {
      const assetId = (request.params as { id: string }).id;
      const projectId = (request.query as { projectId?: string }).projectId;
      const conditions = [eq(assets.id, assetId), eq(assets.userId, request.user!.id)];
      if (projectId) conditions.push(eq(assets.projectId, projectId));
      const [asset] = await db.select({ id: assets.id, kind: assets.kind }).from(assets).where(
        and(...conditions),
      );
      if (!asset) throw new AppError('NOT_FOUND', 'Asset not found', 404);
      if (!['audio', 'video'].includes(asset.kind))
        throw new AppError(
          'BAD_INPUT',
          'Transcripts can only be attached to audio or video assets',
        );
      const body = request.body as { transcript?: unknown } | unknown;
      const candidate = body && typeof body === 'object' && 'transcript' in body
        ? (body as { transcript: unknown }).transcript
        : body;
      const parsed = TranscriptSchema.safeParse(candidate);
      if (!parsed.success)
        throw new AppError('BAD_INPUT', 'Invalid transcript', 400, parsed.error.issues);
      const [row] = await db.insert(transcripts).values({
        assetId,
        language: parsed.data.language,
        text: parsed.data.text,
        words: parsed.data.words,
        durationSeconds: parsed.data.durationSeconds,
      }).returning();
      return reply.code(201).send(row);
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/transcripts/:id', async (request, reply) => {
    const projectId = (request.query as { projectId?: string }).projectId;
    const conditions = [
      eq(transcripts.id, (request.params as { id: string }).id),
      eq(assets.userId, request.user!.id),
    ];
    if (projectId) conditions.push(eq(assets.projectId, projectId));
    const [row] = await db
      .select({ transcript: transcripts })
      .from(transcripts)
      .innerJoin(assets, eq(transcripts.assetId, assets.id))
      .where(and(...conditions));
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Transcript not found', 404),
      );
    return reply.send(row.transcript);
  });
  app.get('/assets/:id/transcripts', async (request, reply) => {
    const projectId = (request.query as { projectId?: string }).projectId;
    const conditions = [
      eq(assets.id, (request.params as { id: string }).id),
      eq(assets.userId, request.user!.id),
    ];
    if (projectId) conditions.push(eq(assets.projectId, projectId));
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(...conditions));
    if (!asset)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Asset not found', 404),
      );
    return reply.send({
      items: await db
        .select()
        .from(transcripts)
        .where(eq(transcripts.assetId, asset.id))
        .orderBy(desc(transcripts.createdAt)),
    });
  });
};
