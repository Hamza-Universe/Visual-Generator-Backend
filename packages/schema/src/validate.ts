import * as AjvNamespace from 'ajv';
import * as FormatsNamespace from 'ajv-formats';
import type { RegistryComponent } from './registry.js';
import type { VideoSpec } from './spec.js';

export type Issue = { path: string; code: string; message: string };
export type ValidationContext = {
  registry: Map<string, RegistryComponent>;
  assetExists: (id: string) => boolean;
  assetKind: (id: string) => string | undefined;
  maxComponents?: number;
};

const paletteRef = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('palette:');
const addColorIssue = (
  value: unknown,
  path: string,
  palette: Record<string, string>,
  issues: Issue[],
) => {
  if (paletteRef(value) && !(value.slice('palette:'.length) in palette))
    issues.push({
      path,
      code: 'UNKNOWN_PALETTE_COLOR',
      message: `Palette color ${value} does not exist`,
    });
};

export const validateSpec = (
  spec: VideoSpec,
  ctx: ValidationContext,
): Issue[] => {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  type AjvError = { instancePath: string; message?: string };
  type Validator = ((data: unknown) => boolean) & {
    errors?: AjvError[] | null;
  };
  type AjvLike = {
    new (options?: Record<string, unknown>): {
      compile(schema: unknown): Validator;
    };
  };
  const Ajv = AjvNamespace.default as unknown as AjvLike;
  const addFormats = FormatsNamespace.default as unknown as (
    instance: unknown,
  ) => void;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const sceneIds = new Set(spec.scenes.map((scene) => scene.id));
  if (ctx.maxComponents !== undefined && spec.scenes.length > ctx.maxComponents)
    issues.push({
      path: 'scenes',
      code: 'TOO_MANY_SCENES',
      message: `Spec contains more than ${ctx.maxComponents} scenes`,
    });

  spec.scenes.forEach((scene, index) => {
    const path = `scenes[${index}]`;
    if (ids.has(scene.id))
      issues.push({
        path: `${path}.id`,
        code: 'DUPLICATE_SCENE_ID',
        message: `Scene id ${scene.id} is duplicated`,
      });
    ids.add(scene.id);
    const component = ctx.registry.get(scene.component);
    if (!component) {
      issues.push({
        path: `${path}.component`,
        code: 'UNKNOWN_COMPONENT',
        message: `Unknown component ${scene.component}`,
      });
      return;
    }
    const validator = ajv.compile(component.propsSchema);
    const valid = validator(
      Object.assign({}, component.defaultProps, scene.props),
    );
    if (!valid)
      for (const error of validator.errors ?? [])
        issues.push({
          path: `${path}.props${error.instancePath.replaceAll('/', '.')}`,
          code: 'INVALID_PROPS',
          message: error.message ?? 'Invalid props',
        });
    if (!component.enterStyles.includes(scene.enter.style))
      issues.push({
        path: `${path}.enter.style`,
        code: 'UNKNOWN_ENTER_STYLE',
        message: `Unknown enter style ${scene.enter.style}`,
      });
    if (scene.exit && !component.exitStyles.includes(scene.exit.style))
      issues.push({
        path: `${path}.exit.style`,
        code: 'UNKNOWN_EXIT_STYLE',
        message: `Unknown exit style ${scene.exit.style}`,
      });
    if (scene.exit && component.exitStyles.length === 0)
      issues.push({
        path: `${path}.exit`,
        code: 'UNKNOWN_EXIT_STYLE',
        message: 'Component has no exit styles',
      });
    if (scene.at + scene.duration > spec.meta.durationInSeconds + 0.001)
      issues.push({
        path,
        code: 'SCENE_OUT_OF_RANGE',
        message: 'Scene extends beyond video duration',
      });
    if (
      (scene.enter.duration + (scene.exit?.duration ?? 0)) / spec.theme.speed >
      scene.duration
    )
      issues.push({
        path,
        code: 'TRANSITIONS_TOO_LONG',
        message: 'Transitions exceed scene duration',
      });
    addColorIssue(scene.color, `${path}.color`, spec.theme.palette, issues);
    for (const prop of component.colorProps)
      addColorIssue(
        scene.props[prop],
        `${path}.props.${prop}`,
        spec.theme.palette,
        issues,
      );
    for (const prop of component.refProps) {
      const ref = scene.props[prop];
      if (typeof ref !== 'string' || !sceneIds.has(ref) || ref === scene.id)
        issues.push({
          path: `${path}.props.${prop}`,
          code: 'BAD_REFERENCE',
          message: `${prop} must reference another scene`,
        });
    }
    for (const prop of component.assetProps) {
      const asset = scene.props[prop];
      if (typeof asset !== 'string' || !ctx.assetExists(asset))
        issues.push({
          path: `${path}.props.${prop}`,
          code: 'UNKNOWN_ASSET',
          message: `${prop} references an unknown asset`,
        });
    }
  });
  addColorIssue(
    spec.theme.background.type === 'color'
      ? spec.theme.background.color
      : undefined,
    'theme.background.color',
    spec.theme.palette,
    issues,
  );
  if (spec.theme.background.type === 'gradient') {
    addColorIssue(
      spec.theme.background.from,
      'theme.background.from',
      spec.theme.palette,
      issues,
    );
    addColorIssue(
      spec.theme.background.to,
      'theme.background.to',
      spec.theme.palette,
      issues,
    );
  }
  if (
    spec.theme.background.type === 'image' &&
    !ctx.assetExists(spec.theme.background.assetId)
  )
    issues.push({
      path: 'theme.background.assetId',
      code: 'UNKNOWN_ASSET',
      message: 'Background image references an unknown asset',
    });
  if (
    spec.audioAssetId &&
    (!ctx.assetExists(spec.audioAssetId) ||
      !['audio', 'video'].includes(ctx.assetKind(spec.audioAssetId) ?? ''))
  )
    issues.push({
      path: 'audioAssetId',
      code: 'UNKNOWN_ASSET',
      message: 'Audio asset must exist and be audio or video',
    });
  if (
    spec.sideVideo &&
    (!ctx.assetExists(spec.sideVideo.assetId) ||
      ctx.assetKind(spec.sideVideo.assetId) !== 'side_video')
  )
    issues.push({
      path: 'sideVideo.assetId',
      code: 'UNKNOWN_ASSET',
      message: 'Side video asset must exist and have kind side_video',
    });
  return issues;
};
