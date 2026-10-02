import {
  VideoSpecSchema,
  validateSpec,
  type RegistryComponent,
  type VideoSpec,
} from '@app/schema';
import type { Database } from '@app/db';
import { assets, components } from '@app/db';
import { eq } from 'drizzle-orm';
export const loadGenerationContext = async (
  db: Database,
  maxComponents?: number | null,
  userId?: string,
) => {
  const rows = await db.select().from(components);
  const assetRows = userId
    ? await db.select().from(assets).where(eq(assets.userId, userId))
    : await db.select().from(assets);
  const registry = new Map(
    rows.map((row) => [row.name, row as unknown as RegistryComponent]),
  );
  return {
    rows,
    assetRows,
    context: {
      registry,
      assetExists: (id: string) => assetRows.some((asset) => asset.id === id),
      assetKind: (id: string) =>
        assetRows.find((asset) => asset.id === id)?.kind,
      maxComponents: maxComponents ?? undefined,
    },
  };
};
export const parseGeneratedSpec = (
  raw: unknown,
  context: Parameters<typeof validateSpec>[1],
) => {
  const parsed = VideoSpecSchema.safeParse(raw);
  if (!parsed.success)
    return {
      spec: undefined,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: 'INVALID_SHAPE',
        message: issue.message,
      })),
    };
  const issues = validateSpec(parsed.data, context);
  return { spec: issues.length ? undefined : parsed.data, issues };
};
export const preserveProjectSettings = (
  spec: VideoSpec,
  current: VideoSpec,
  audioAssetId?: string,
) => ({
  ...spec,
  theme: current.theme,
  meta: {
    ...spec.meta,
    fps: current.meta.fps,
    width: current.meta.width,
    height: current.meta.height,
  },
  ...(audioAssetId ? { audioAssetId } : {}),
});
