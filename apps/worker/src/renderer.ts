import { bundle } from '@remotion/bundler';
import { getCompositions, renderMedia } from '@remotion/renderer';
import { SceneDocumentSchema, type VideoSpec } from '@app/schema';
import { resolveTimeline } from '@app/render';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderAsset } from './remotion/video.js';
import type { SceneCompositionProps } from './remotion/scene.js';

export type RenderInputAsset = RenderAsset & { sourcePath: string };

/**
 * Production render boundary (Stage 3E).
 *
 * Two paths coexist:
 *   - legacy `VideoSpec` → `renderProject` → `VisualDiagram` composition
 *   - new `SceneDocument` snapshot → `renderSceneDocument` →
 *     `SceneDocumentProduction` composition (shared evaluator + render tree)
 * `SceneDocument` is the canonical source for the new path; the legacy
 * VideoSpec pipeline is preserved untouched for compatibility.
 */

export const renderProject = async (input: {
  spec: VideoSpec;
  assets: RenderInputAsset[];
  outputPath: string;
  onProgress: (progress: number) => Promise<void> | void;
}) => {
  const entryPoint = fileURLToPath(
    new URL('./remotion/index.js', import.meta.url),
  );
  const publicDir = `${input.outputPath}.public`;
  await mkdir(publicDir, { recursive: true });
  try {
    const assets: Record<string, RenderAsset> = {};
    for (const asset of input.assets) {
      const fileName = `${asset.id}${extname(basename(asset.sourcePath))}`;
      await copyFile(asset.sourcePath, join(publicDir, fileName));
      assets[asset.id] = {
        id: asset.id,
        kind: asset.kind,
        fileName,
        mimeType: asset.mimeType,
      };
    }
    const serveUrl = await bundle({ entryPoint, publicDir });
    const inputProps = { spec: input.spec, assets };
    const compositions = await getCompositions(serveUrl, { inputProps });
    const composition = compositions.find(
      (candidate) => candidate.id === 'VisualDiagram',
    );
    if (!composition)
      throw new Error('VisualDiagram Remotion composition was not found');
    await input.onProgress(0);
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: input.outputPath,
      inputProps,
      onProgress: ({ progress }) =>
        input.onProgress(Math.round(progress * 100)),
    });
    await input.onProgress(100);
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
};

/**
 * Production SceneDocument render path (Stage 3E).
 *
 *   immutable SceneDocument snapshot
 *     → `SceneDocumentProduction` composition (timeline from document.timeline,
 *        per-frame output from the shared evaluator — no new evaluator)
 *     → renderMedia()
 *     → output video
 *
 * Pure render step: no AI, no document mutation, no database access, no
 * editor state. Invalid documents fail fast via schema validation with a
 * clear error. Structural mirror of `renderProject` so the legacy
 * VideoSpec pipeline stays intact beside it.
 */
export const renderSceneDocument = async (input: {
  document: NonNullable<SceneCompositionProps['document']>;
  definitions: NonNullable<SceneCompositionProps['definitions']>;
  background?: string;
  assets: RenderInputAsset[];
  outputPath: string;
  onProgress: (progress: number) => Promise<void> | void;
}) => {
  // Fail fast on invalid production documents (never silently corrupt a render).
  const document = SceneDocumentSchema.parse(input.document);
  const entryPoint = fileURLToPath(
    new URL('./remotion/index.js', import.meta.url),
  );
  const publicDir = `${input.outputPath}.public`;
  await mkdir(publicDir, { recursive: true });
  try {
    const assets: Record<string, RenderAsset> = {};
    for (const asset of input.assets) {
      const fileName = `${asset.id}${extname(basename(asset.sourcePath))}`;
      await copyFile(asset.sourcePath, join(publicDir, fileName));
      assets[asset.id] = {
        id: asset.id,
        kind: asset.kind,
        fileName,
        mimeType: asset.mimeType,
      };
    }
    const timeline = resolveTimeline(document);
    const inputProps = {
      document,
      definitions: input.definitions,
      background: input.background,
      assets,
    };
    const serveUrl = await bundle({ entryPoint, publicDir });
    const compositions = await getCompositions(serveUrl, { inputProps });
    const composition = compositions.find(
      (candidate) => candidate.id === 'SceneDocumentProduction',
    );
    if (!composition)
      throw new Error('SceneDocumentProduction Remotion composition was not found');
    await input.onProgress(0);
    await renderMedia({
      composition: {
        ...composition,
        durationInFrames: timeline.durationFrames,
        fps: timeline.fps,
      },
      serveUrl,
      codec: 'h264',
      outputLocation: input.outputPath,
      inputProps,
      onProgress: ({ progress }) =>
        input.onProgress(Math.round(progress * 100)),
    });
    await input.onProgress(100);
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
};
