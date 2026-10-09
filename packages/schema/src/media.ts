import { z } from 'zod';

/**
 * Shared media, format, layout-preset, caption and effect contracts (Prompt 2).
 *
 * These are ADDITIVE. Existing documents (`SceneDocument`, `VideoSpec`) keep
 * parsing unchanged; the new element kinds are opt-in. Nothing here renders:
 * the single rendering implementation remains `@app/render` + the worker.
 */

// ---------------------------------------------------------------------------
// Aspect ratio / output format
// ---------------------------------------------------------------------------

export const ASPECT_RATIOS = ['landscape', 'portrait', 'square'] as const;
export const AspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;
export const DEFAULT_ASPECT_RATIO: AspectRatio = 'landscape';

/** Canonical output resolution per aspect ratio (1080p class). */
export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

export const dimensionsForAspect = (aspect: AspectRatio) => ASPECT_DIMENSIONS[aspect];

/** Parses an unknown value as an aspect ratio, falling back to the default. */
export const resolveAspectRatio = (value: unknown): AspectRatio => {
  const parsed = AspectRatioSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_ASPECT_RATIO;
};

// ---------------------------------------------------------------------------
// Media elements (opt-in element kinds for scene documents)
// ---------------------------------------------------------------------------

/** Asset kinds accepted by the API. Must stay in sync with routes/assets.ts. */
export const MEDIA_ASSET_KINDS = ['audio', 'video', 'image', 'logo', 'side_video'] as const;
export const MediaAssetKindSchema = z.enum(MEDIA_ASSET_KINDS);
export type MediaAssetKind = z.infer<typeof MediaAssetKindSchema>;

const finiteNonNegative = z.number().finite().min(0);

/** A short video clip placed on the canvas. `inSeconds`/`outSeconds` trim the source. */
export const VideoClipElementSchema = z
  .object({
    type: z.literal('videoClip'),
    assetId: z.string().uuid(),
    inSeconds: finiteNonNegative.default(0),
    outSeconds: finiteNonNegative.optional(),
    muted: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.outSeconds !== undefined && value.outSeconds <= value.inSeconds) {
      ctx.addIssue({ code: 'custom', path: ['outSeconds'], message: 'outSeconds must be greater than inSeconds' });
    }
  });

/** Audio track (narration, voice recording, background music). */
export const AudioElementSchema = z
  .object({
    type: z.literal('audio'),
    assetId: z.string().uuid(),
    role: z.enum(['narration', 'voice', 'background']).default('background'),
    inSeconds: finiteNonNegative.default(0),
    outSeconds: finiteNonNegative.optional(),
    /** Linear gain; 0 = silent, 1 = source level. Capped to avoid clipping abuse. */
    volume: z.number().finite().min(0).max(2).default(1),
    startSeconds: finiteNonNegative.default(0),
  })
  .superRefine((value, ctx) => {
    if (value.outSeconds !== undefined && value.outSeconds <= value.inSeconds) {
      ctx.addIssue({ code: 'custom', path: ['outSeconds'], message: 'outSeconds must be greater than inSeconds' });
    }
  });

/** One caption cue. Times are scene-relative seconds. */
export const CaptionCueSchema = z
  .object({
    startSeconds: finiteNonNegative,
    endSeconds: finiteNonNegative,
    text: z.string().min(1).max(500),
  })
  .superRefine((value, ctx) => {
    if (value.endSeconds <= value.startSeconds) {
      ctx.addIssue({ code: 'custom', path: ['endSeconds'], message: 'endSeconds must be greater than startSeconds' });
    }
  });

export const CaptionElementSchema = z.object({
  type: z.literal('caption'),
  transcriptId: z.string().uuid().optional(),
  cues: z.array(CaptionCueSchema).max(2000).default([]),
  /** Caption placement inside the frame. */
  placement: z.enum(['top', 'center', 'bottom']).default('bottom'),
});

// ---------------------------------------------------------------------------
// Layout presets (data, not code). Each preset maps to rectangles expressed
// as fractions of the canvas so the SAME preset yields the SAME geometry in
// the editor and in the worker for any aspect ratio.
// ---------------------------------------------------------------------------

export const LAYOUT_PRESET_IDS = [
  'screen-only',
  'picture-in-picture',
  'circular-webcam',
  'vertical-presenter-screen',
  'side-by-side',
] as const;
export const LayoutPresetIdSchema = z.enum(LAYOUT_PRESET_IDS);
export type LayoutPresetId = z.infer<typeof LayoutPresetIdSchema>;

/** Normalised rectangle, 0..1 of canvas width/height. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPresetSlot {
  slot: 'screen' | 'presenter';
  rect: NormalizedRect;
  shape: 'rect' | 'circle';
}

export interface LayoutPreset {
  id: LayoutPresetId;
  label: string;
  /** Aspect ratios the preset is designed for. */
  aspects: readonly AspectRatio[];
  slots: readonly LayoutPresetSlot[];
}

export const LAYOUT_PRESETS: Record<LayoutPresetId, LayoutPreset> = {
  'screen-only': {
    id: 'screen-only',
    label: 'Screen only',
    aspects: ['landscape', 'portrait', 'square'],
    slots: [{ slot: 'screen', rect: { x: 0, y: 0, width: 1, height: 1 }, shape: 'rect' }],
  },
  'picture-in-picture': {
    id: 'picture-in-picture',
    label: 'Picture-in-picture presenter',
    aspects: ['landscape', 'square'],
    slots: [
      { slot: 'screen', rect: { x: 0, y: 0, width: 1, height: 1 }, shape: 'rect' },
      { slot: 'presenter', rect: { x: 0.72, y: 0.66, width: 0.25, height: 0.31 }, shape: 'rect' },
    ],
  },
  'circular-webcam': {
    id: 'circular-webcam',
    label: 'Circular webcam overlay',
    aspects: ['landscape', 'portrait', 'square'],
    slots: [
      { slot: 'screen', rect: { x: 0, y: 0, width: 1, height: 1 }, shape: 'rect' },
      { slot: 'presenter', rect: { x: 0.04, y: 0.7, width: 0.22, height: 0.22 }, shape: 'circle' },
    ],
  },
  'vertical-presenter-screen': {
    id: 'vertical-presenter-screen',
    label: 'Vertical presenter and screen',
    aspects: ['portrait'],
    slots: [
      { slot: 'presenter', rect: { x: 0, y: 0, width: 1, height: 0.4 }, shape: 'rect' },
      { slot: 'screen', rect: { x: 0, y: 0.4, width: 1, height: 0.6 }, shape: 'rect' },
    ],
  },
  'side-by-side': {
    id: 'side-by-side',
    label: 'Side by side',
    aspects: ['landscape', 'square'],
    slots: [
      { slot: 'presenter', rect: { x: 0, y: 0, width: 0.4, height: 1 }, shape: 'rect' },
      { slot: 'screen', rect: { x: 0.4, y: 0, width: 0.6, height: 1 }, shape: 'rect' },
    ],
  },
};

export const getLayoutPreset = (id: LayoutPresetId): LayoutPreset => LAYOUT_PRESETS[id];

export const layoutPresetSupportsAspect = (id: LayoutPresetId, aspect: AspectRatio): boolean =>
  LAYOUT_PRESETS[id].aspects.includes(aspect);

// ---------------------------------------------------------------------------
// Effects (targeted and full-screen). Effects are data evaluated by the same
// deterministic evaluator as motion; they are not a separate render path.
// ---------------------------------------------------------------------------

export const EFFECT_KINDS = ['fade', 'slide', 'wipe', 'zoom', 'blur', 'brightness'] as const;
export const EffectKindSchema = z.enum(EFFECT_KINDS);
export type EffectKind = z.infer<typeof EffectKindSchema>;

/**
 * target:
 *  - `scene`: full-screen, applied to the whole frame (transitions use this).
 *  - `element`: applied to one component instance by id.
 *  - `region`: applied to a normalised rectangle of the frame.
 */
export const EffectTargetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('scene') }),
  z.object({ scope: z.literal('element'), instanceId: z.string().uuid() }),
  z.object({
    scope: z.literal('region'),
    rect: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().gt(0).max(1),
        height: z.number().gt(0).max(1),
      })
      .superRefine((rect, ctx) => {
        // A region must lie inside the frame, not just have in-range fields.
        if (rect.x + rect.width > 1 + 1e-9) {
          ctx.addIssue({ code: 'custom', path: ['width'], message: 'region exceeds the frame horizontally' });
        }
        if (rect.y + rect.height > 1 + 1e-9) {
          ctx.addIssue({ code: 'custom', path: ['height'], message: 'region exceeds the frame vertically' });
        }
      }),
  }),
]);

export const EffectSchema = z.object({
  id: z.string().min(1).max(64),
  kind: EffectKindSchema,
  target: EffectTargetSchema,
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1).max(864000),
  /** Strength in 0..1; meaning depends on `kind`. */
  amount: z.number().finite().min(0).max(1).default(1),
});

export type EffectTarget = z.infer<typeof EffectTargetSchema>;
export type Effect = z.infer<typeof EffectSchema>;

// ---------------------------------------------------------------------------
// Opt-in element union used by the new contracts.
// ---------------------------------------------------------------------------

export const MediaElementSchema = z.discriminatedUnion('type', [
  VideoClipElementSchema,
  AudioElementSchema,
  CaptionElementSchema,
]);
export type MediaElement = z.infer<typeof MediaElementSchema>;
