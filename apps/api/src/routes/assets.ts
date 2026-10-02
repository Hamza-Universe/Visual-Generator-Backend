import { and, eq, desc } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { assets, assetShareLinks, projects } from '@app/db';
import type { Database } from '@app/db';
import { LocalStorage } from '@app/storage';
import { AppError, sendError } from '../errors.js';

const kinds = ['audio', 'video', 'image', 'logo', 'side_video'] as const;
const allowedMimeTypes: Record<(typeof kinds)[number], RegExp> = {
  audio: /^audio\//,
  video: /^video\//,
  image: /^image\//,
  logo: /^image\//,
  side_video: /^video\//,
};
export const registerAssetRoutes = (
  app: FastifyInstance,
  db: Database,
  storage: LocalStorage,
  maxUploadMb: number,
  publicBaseUrl: string,
) => {
  app.post('/assets', async (request, reply) => {
    try {
      const parts = request.parts();
      let filePart: Awaited<ReturnType<typeof request.file>>;
      let fileData: Buffer | undefined;
      let kind = '';
      for await (const part of parts) {
        if (part.type === 'file') {
          filePart = part;
          fileData = await part.toBuffer();
        }
        else if (part.fieldname === 'kind') kind = String(part.value);
      }
      if (!filePart || !kinds.includes(kind as (typeof kinds)[number]))
        throw new AppError('BAD_INPUT', 'file and valid kind are required');
      if (
        !allowedMimeTypes[kind as (typeof kinds)[number]].test(
          filePart.mimetype,
        )
      )
        throw new AppError(
          'BAD_INPUT',
          `MIME type ${filePart.mimetype} is not valid for ${kind}`,
        );
      const data = fileData ?? Buffer.alloc(0);
      if (data.byteLength > maxUploadMb * 1024 * 1024)
        throw new AppError('FILE_TOO_LARGE', 'File exceeds MAX_UPLOAD_MB', 413);
      const key = await storage.save({
        data,
        extension: filePart.filename.includes('.')
          ? `.${filePart.filename.split('.').pop()}`
          : '',
      });
      let row: typeof assets.$inferSelect | undefined;
      try {
        [row] = await db
          .insert(assets)
          .values({
            kind,
            originalName: filePart.filename,
            storageKey: key,
            mimeType: filePart.mimetype,
            sizeBytes: data.byteLength,
            userId: request.user!.id,
          })
          .returning();
      } catch (error) {
        await storage.remove(key).catch(() => undefined);
        throw error;
      }
      if (!row) {
        await storage.remove(key).catch(() => undefined);
        throw new AppError('INTERNAL_ERROR', 'Asset could not be saved', 500);
      }
      return reply.code(201).send(row);
    } catch (error) {
      if (
        ['FST_ERR_CTP_BODY_TOO_LARGE', 'FST_REQ_FILE_TOO_LARGE'].includes(
          (error as { code?: string }).code ?? '',
        )
      )
        return sendError(
          reply,
          new AppError('FILE_TOO_LARGE', 'File exceeds MAX_UPLOAD_MB', 413),
        );
      return sendError(reply, error);
    }
  });
  app.post('/assets/:id/share-url', async (request, reply) => {
    try {
      const assetId = (request.params as { id: string }).id;
      const [asset] = await db.select({ id: assets.id }).from(assets).where(
        and(eq(assets.id, assetId), eq(assets.userId, request.user!.id)),
      );
      if (!asset) throw new AppError('NOT_FOUND', 'Asset not found', 404);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await db.insert(assetShareLinks).values({
        assetId,
        userId: request.user!.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt,
      });
      return reply.code(201).send({
        url: `${publicBaseUrl.replace(/\/$/, '')}/assets/${assetId}/public-file/${token}`,
        expiresAt,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
  app.get('/assets/:id/public-file/:token', async (request, reply) => {
    const { id, token } = request.params as { id: string; token: string };
    const [row] = await db.select({ asset: assets, link: assetShareLinks }).from(assetShareLinks)
      .innerJoin(assets, eq(assetShareLinks.assetId, assets.id))
      .where(and(eq(assetShareLinks.assetId, id), eq(assetShareLinks.tokenHash, createHash('sha256').update(token).digest('hex'))));
    if (!row || row.link.revokedAt || row.link.expiresAt <= new Date())
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Media URL not found', details: [] } });
    const filePath = storage.path(row.asset.storageKey);
    const fileStat = await stat(filePath);
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : Math.max(0, fileStat.size - Number(match[2]));
        const end = match[2] ? Number(match[2]) : fileStat.size - 1;
        if (start <= end && start < fileStat.size) {
          const boundedEnd = Math.min(end, fileStat.size - 1);
          return reply.code(206).header('accept-ranges', 'bytes').header('content-range', `bytes ${start}-${boundedEnd}/${fileStat.size}`).header('content-length', boundedEnd - start + 1).type(row.asset.mimeType).send((await import('node:fs')).createReadStream(filePath, { start, end: boundedEnd }));
        }
      }
    }
    return reply.header('accept-ranges', 'bytes').header('content-length', fileStat.size).type(row.asset.mimeType).send(storage.stream(row.asset.storageKey));
  });
  app.get('/assets', async (request, reply) => {
    const kind = (request.query as { kind?: string }).kind;
    const rows = await db
      .select()
      .from(assets)
      .where(eq(assets.userId, request.user!.id))
      .orderBy(desc(assets.createdAt));
    return reply.send({
      items: kind ? rows.filter((row) => row.kind === kind) : rows,
    });
  });
  app.get('/assets/:id/file', async (request, reply) => {
    const [row] = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, (request.params as { id: string }).id),
          eq(assets.userId, request.user!.id),
        ),
      );
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Asset not found', 404),
      );
    return reply.type(row.mimeType).send(storage.stream(row.storageKey));
  });
  app.delete('/assets/:id', async (request, reply) => {
    const [row] = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, (request.params as { id: string }).id),
          eq(assets.userId, request.user!.id),
        ),
      );
    if (!row)
      return sendError(
        reply,
        new AppError('NOT_FOUND', 'Asset not found', 404),
      );
    const ownedProjects = await db
      .select({ spec: projects.spec })
      .from(projects)
      .where(eq(projects.userId, request.user!.id));
    if (ownedProjects.some((project) => JSON.stringify(project.spec).includes(row.id)))
      return sendError(
        reply,
        new AppError('IN_USE', 'Asset is referenced by a project', 409),
      );
    await storage.remove(row.storageKey);
    await db
      .delete(assets)
      .where(and(eq(assets.id, row.id), eq(assets.userId, request.user!.id)));
    return reply.code(204).send();
  });
};
