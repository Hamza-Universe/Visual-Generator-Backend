import { bundle } from '@remotion/bundler';
import { getCompositions, renderMedia } from '@remotion/renderer';
import type { VideoSpec } from '@app/schema';
import { resolveTimeline } from '@app/render';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderAsset } from './remotion/video.js';
import type { SceneCompositionProps } from './remotion/scene.js';

export type RenderInputAsset = RenderAsset & { sourcePath: string };

/**
 * Production render boundary (Stage 3B, Phase 13/17).
 *
 * Two paths temporarily coexist:
 *   - legacy `VideoSpec` → `renderProject` (production worker, untouched)
 *   - new `SceneDocument` → `renderSceneDocument` (frame-aware, verified here)
 * Migrating production from VideoSpec to SceneDocument belongs to the next
 * stage; nothing legacy is deleted or broken here.
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
 * Frame-aware SceneDocument render path (Stage 3B).
 *
 * Bundles the same Remotion entrypoint and renders the
 * `SceneDocumentPreview` composition, whose FPS/duration resolve from
 * `document.timeline` and whose per-frame output comes from
 * `evaluateSceneAtFrame()`. Structural mirror of `renderProject` so the
 * legacy pipeline stays intact beside it.
 */
export const renderSceneDocument = async (input: {
  document: NonNullable<SceneCompositionProps['document']>;
  definitions: NonNullable<SceneCompositionProps['definitions']>;
  background?: string;
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
    void assets;
    const timeline = resolveTimeline(input.document);
    const inputProps = {
      document: input.document,
      definitions: input.definitions,
      background: input.background,
    };
    const serveUrl = await bundle({ entryPoint, publicDir });
    const compositions = await getCompositions(serveUrl, { inputProps });
    const composition = compositions.find(
      (candidate) => candidate.id === 'SceneDocumentPreview',
    );
    if (!composition)
      throw new Error('SceneDocumentPreview Remotion composition was not found');
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
