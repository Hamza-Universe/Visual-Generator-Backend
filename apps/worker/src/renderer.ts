import { bundle } from '@remotion/bundler';
import { getCompositions, renderMedia } from '@remotion/renderer';
import type { VideoSpec } from '@app/schema';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderAsset } from './remotion/video.js';

export type RenderInputAsset = RenderAsset & { sourcePath: string };

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
