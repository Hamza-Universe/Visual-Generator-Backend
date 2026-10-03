import { z } from 'zod';
export const TranscriptWordSchema = z.object({
    word: z.string().min(1),
    start: z.number().min(0),
    end: z.number().positive(),
}).refine((value) => value.end >= value.start, 'word end must be after start');
export const TranscriptSchema = z.object({
    version: z.literal(1).default(1),
    language: z.string().min(1).optional(),
    text: z.string().min(1),
    durationSeconds: z.number().positive().optional(),
    words: z.array(TranscriptWordSchema).default([]),
});
export const EasingSchema = z.enum([
    'linear',
    'ease-in',
    'ease-out',
    'ease-in-out',
    'spring',
]);
export const AnchorSchema = z.enum([
    'top-left',
    'top-center',
    'top-right',
    'center-left',
    'center',
    'center-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
]);
export const COLOR_PATTERN = '^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|palette:[a-zA-Z0-9_-]+)$';
export const ColorSchema = z.string().regex(new RegExp(COLOR_PATTERN));
export const TransitionSchema = z.object({
    style: z.string().min(1),
    duration: z.number().min(0).max(10).default(0.5),
    easing: EasingSchema.default('ease-out'),
});
export const BackgroundSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('color'), color: ColorSchema }),
    z.object({
        type: z.literal('gradient'),
        from: ColorSchema,
        to: ColorSchema,
        angle: z.number().min(0).max(360).default(180),
    }),
    z.object({
        type: z.literal('image'),
        assetId: z.string().uuid(),
        fit: z.enum(['cover', 'contain']).default('cover'),
    }),
]);
export const ThemeSchema = z.object({
    background: BackgroundSchema,
    palette: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    fontFamily: z.string().min(1).default('Inter'),
    speed: z.number().min(0.25).max(4).default(1),
    defaultEasing: EasingSchema.default('ease-out'),
});
export const PositionSchema = z.object({
    anchor: AnchorSchema.default('center'),
    offsetX: z.number().min(-50).max(50).default(0),
    offsetY: z.number().min(-50).max(50).default(0),
});
export const SceneSchema = z.object({
    id: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
        .max(64),
    component: z.string().min(1),
    at: z.number().min(0),
    duration: z.number().positive(),
    position: PositionSchema.default({
        anchor: 'center',
        offsetX: 0,
        offsetY: 0,
    }),
    props: z.record(z.string(), z.unknown()).default({}),
    color: ColorSchema.optional(),
    enter: TransitionSchema,
    exit: TransitionSchema.optional(),
    trigger: z
        .object({
        word: z.string().min(1),
        occurrence: z.number().int().min(1).default(1),
    })
        .optional(),
});
export const MetaSchema = z.object({
    fps: z.number().int().min(10).max(60).default(30),
    width: z.number().int().min(320).max(3840).default(1920),
    height: z.number().int().min(240).max(2160).default(1080),
    durationInSeconds: z.number().positive().max(3600),
});
export const SideVideoSchema = z.object({
    assetId: z.string().uuid(),
    position: PositionSchema.default({
        anchor: 'bottom-right',
        offsetX: 0,
        offsetY: 0,
    }),
    sizePercent: z.number().min(5).max(40).default(18),
    shape: z.enum(['circle', 'rounded', 'square']).default('circle'),
});
export const VideoSpecSchema = z.object({
    version: z.literal(1),
    meta: MetaSchema,
    theme: ThemeSchema,
    audioAssetId: z.string().uuid().optional(),
    sideVideo: SideVideoSchema.optional(),
    scenes: z.array(SceneSchema).max(300),
});
export const defaultSpec = () => VideoSpecSchema.parse({
    version: 1,
    meta: { fps: 30, width: 1920, height: 1080, durationInSeconds: 10 },
    theme: {
        background: { type: 'color', color: '#EFE9DC' },
        palette: {
            primary: '#F5A623',
            text: '#2B2620',
            surface: '#FFFFFF',
            accent: '#1F3A93',
        },
    },
    scenes: [],
});
