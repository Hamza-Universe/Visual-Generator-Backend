import { z } from 'zod';

/**
 * Semantic layout intent schema (Stage 4C).
 *
 * The layout API is intent-based: callers (AI plans, the editor, MCP tools)
 * describe WHAT the arrangement should achieve — a row, a grid, centered
 * composition, relationship flow, text-fit sizing — and the deterministic
 * layout engine in `@app/render` (`resolveLayout`) turns that intent into
 * concrete geometry. Raw coordinates stay available (`moveInstance`), but
 * semantic layout is the preferred vocabulary for arranging objects.
 *
 * Overlap is a first-class, allowed property of layered compositions:
 * nothing here implies packing objects apart. Mark intentional overlaps on
 * an instance with `style.layoutOverlap = 'intentional'` (the plain
 * `StyleSchema` catchall accepts it); the engine never separates marked
 * instances during collision resolution.
 */

export const LayoutAxisSchema = z.enum(['x', 'y']);
export const LayoutEdgeSchema = z.enum(['min', 'center', 'max']);
export const LayoutJustifySchema = z.enum(['start', 'center', 'end']);
export const LayoutGapSchema = z.number().min(0).max(4000);

/**
 * Container a layout resolves against: the canvas, one instance's box, or
 * a group's bounds (the union of its members, nested groups included).
 * Exactly one id field is required per kind — enforced here so invalid
 * containers fail plan parsing, and again in plan validation for refs that
 * depend on plan-local clientKeys.
 */
export const LayoutContainerSchema = z
  .object({
    kind: z.enum(['canvas', 'instance', 'group']),
    instanceId: z.string().uuid().optional(),
    instanceClientKey: z.string().min(1).max(64).optional(),
    groupId: z.string().uuid().optional(),
    groupClientKey: z.string().min(1).max(64).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'canvas') {
      if (value.instanceId || value.instanceClientKey || value.groupId || value.groupClientKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'canvas container takes no id fields',
        });
      }
      return;
    }
    if (value.kind === 'instance') {
      if (!value.instanceId && !value.instanceClientKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['instanceId'],
          message: 'instance container requires instanceId or instanceClientKey',
        });
      }
      if (value.groupId || value.groupClientKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['groupId'],
          message: 'instance container cannot reference a group',
        });
      }
      return;
    }
    if (!value.groupId && !value.groupClientKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['groupId'],
        message: 'group container requires groupId or groupClientKey',
      });
    }
    if (value.instanceId || value.instanceClientKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['instanceId'],
        message: 'group container cannot reference an instance',
      });
    }
  });

const HorizontalIntentSchema = z.object({
  type: z.literal('horizontal'),
  gap: LayoutGapSchema.default(16),
  justify: LayoutJustifySchema.default('start'),
  align: LayoutJustifySchema.default('start'),
  container: LayoutContainerSchema.optional(),
});

const VerticalIntentSchema = z.object({
  type: z.literal('vertical'),
  gap: LayoutGapSchema.default(16),
  justify: LayoutJustifySchema.default('start'),
  align: LayoutJustifySchema.default('start'),
  container: LayoutContainerSchema.optional(),
});

const GridIntentSchema = z.object({
  type: z.literal('grid'),
  columns: z.number().int().min(1).max(50).optional(),
  gapX: LayoutGapSchema.default(16),
  gapY: LayoutGapSchema.default(16),
  container: LayoutContainerSchema.optional(),
});

const CenterIntentSchema = z.object({
  type: z.literal('center'),
  mode: z.enum(['block', 'each']).default('block'),
  container: LayoutContainerSchema.optional(),
});

const StackIntentSchema = z.object({
  type: z.literal('stack'),
  equalizeSize: z.boolean().default(false),
  container: LayoutContainerSchema.optional(),
});

const AlignIntentSchema = z.object({
  type: z.literal('align'),
  axis: LayoutAxisSchema,
  mode: LayoutEdgeSchema,
  container: LayoutContainerSchema.optional(),
});

const DistributeIntentSchema = z.object({
  type: z.literal('distribute'),
  axis: LayoutAxisSchema,
});

const FlowIntentSchema = z.object({
  type: z.literal('flow'),
  direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
  gap: LayoutGapSchema.default(60),
  align: LayoutJustifySchema.default('start'),
  container: LayoutContainerSchema.optional(),
});

const FitTextIntentSchema = z.object({
  type: z.literal('fitText'),
  fontSize: z.number().min(1).max(600).optional(),
  maxWidth: z.number().min(1).max(8000).optional(),
  minWidth: z.number().min(1).max(8000).optional(),
  paddingX: z.number().min(0).max(400).default(0),
  paddingY: z.number().min(0).max(400).default(0),
});

const ConstrainIntentSchema = z.object({ type: z.literal('constrain') });

const DetectOverlapsIntentSchema = z.object({
  type: z.literal('detectOverlaps'),
  scope: z.enum(['targets', 'scene']).default('targets'),
});

const ResolveCollisionsIntentSchema = z.object({
  type: z.literal('resolveCollisions'),
  maxPasses: z.number().int().min(1).max(100).optional(),
});

export const LayoutIntentSchema = z.discriminatedUnion('type', [
  HorizontalIntentSchema,
  VerticalIntentSchema,
  GridIntentSchema,
  CenterIntentSchema,
  StackIntentSchema,
  AlignIntentSchema,
  DistributeIntentSchema,
  FlowIntentSchema,
  FitTextIntentSchema,
  ConstrainIntentSchema,
  DetectOverlapsIntentSchema,
  ResolveCollisionsIntentSchema,
]);

export const LAYOUT_INTENT_TYPES = [
  'horizontal',
  'vertical',
  'grid',
  'center',
  'stack',
  'align',
  'distribute',
  'flow',
  'fitText',
  'constrain',
  'detectOverlaps',
  'resolveCollisions',
] as const;

export type LayoutAxis = z.infer<typeof LayoutAxisSchema>;
export type LayoutEdge = z.infer<typeof LayoutEdgeSchema>;
export type LayoutJustify = z.infer<typeof LayoutJustifySchema>;
export type LayoutContainer = z.infer<typeof LayoutContainerSchema>;
export type LayoutIntent = z.infer<typeof LayoutIntentSchema>;
export type LayoutHorizontalIntent = z.infer<typeof HorizontalIntentSchema>;
export type LayoutVerticalIntent = z.infer<typeof VerticalIntentSchema>;
export type LayoutGridIntent = z.infer<typeof GridIntentSchema>;
export type LayoutCenterIntent = z.infer<typeof CenterIntentSchema>;
export type LayoutStackIntent = z.infer<typeof StackIntentSchema>;
export type LayoutAlignIntent = z.infer<typeof AlignIntentSchema>;
export type LayoutDistributeIntent = z.infer<typeof DistributeIntentSchema>;
export type LayoutFlowIntent = z.infer<typeof FlowIntentSchema>;
export type LayoutFitTextIntent = z.infer<typeof FitTextIntentSchema>;

/** Parse-or-throw helper for callers without their own error mapping. */
export const parseLayoutIntent = (value: unknown): LayoutIntent =>
  LayoutIntentSchema.parse(value);

/** The style key/value marking an instance as an intentional layered overlap. */
export const LAYOUT_OVERLAP_STYLE_KEY = 'layoutOverlap';
export const LAYOUT_OVERLAP_INTENTIONAL = 'intentional';

/** Build the style patch that marks (or clears) an intentional overlap. */
export const intentionalOverlapStyle = (
  intentional: boolean,
): Record<string, unknown> =>
  intentional
    ? { [LAYOUT_OVERLAP_STYLE_KEY]: LAYOUT_OVERLAP_INTENTIONAL }
    : { [LAYOUT_OVERLAP_STYLE_KEY]: null };
