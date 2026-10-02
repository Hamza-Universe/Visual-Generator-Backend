import 'dotenv/config';
import { createDb, components } from './index.js';
import { COLOR_PATTERN } from '@app/schema';
import { eq } from 'drizzle-orm';

const db = createDb(
  process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/explainer',
);

const color = { type: 'string', pattern: COLOR_PATTERN };
const seeds = [
  {
    name: 'Hub',
    displayName: 'Hub',
    description:
      'A circle that acts as the central node. Other components connect to it with arrows. Can pulse with a ring.',
    propsSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 40 },
        pulse: { type: 'boolean' },
        color,
      },
      additionalProperties: false,
    },
    defaultProps: { pulse: true },
    enterStyles: ['pop', 'fade'],
    exitStyles: ['fade'],
    colorProps: ['color'],
    refProps: [],
    assetProps: [],
  },
  {
    name: 'LogoCard',
    displayName: 'Logo Card',
    description:
      'A card with a company logo or name. Use it to introduce a company, product, or person.',
    propsSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 40 },
        logoAssetId: { type: 'string', format: 'uuid' },
        variant: { enum: ['light', 'dark'] },
      },
      anyOf: [{ required: ['label'] }, { required: ['logoAssetId'] }],
      additionalProperties: false,
    },
    defaultProps: { variant: 'light' },
    enterStyles: ['pop', 'fade', 'slide-up'],
    exitStyles: ['fade', 'shrink'],
    colorProps: [],
    refProps: [],
    assetProps: ['logoAssetId'],
  },
  {
    name: 'Arrow',
    displayName: 'Arrow',
    description:
      'A line from one scene to another. Use it to show flow, ownership, or a connection. Both ends must be scene ids that exist.',
    propsSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        style: { enum: ['solid', 'dashed'] },
        color,
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    defaultProps: { style: 'dashed' },
    enterStyles: ['draw', 'fade'],
    exitStyles: ['fade'],
    colorProps: ['color'],
    refProps: ['from', 'to'],
    assetProps: [],
  },
  {
    name: 'CounterPill',
    displayName: 'Counter Pill',
    description:
      'A big number that counts up or down. Use it for money, users, percentages, or any changing figure.',
    propsSchema: {
      type: 'object',
      properties: {
        from: { type: 'number' },
        to: { type: 'number' },
        prefix: { type: 'string' },
        suffix: { type: 'string' },
        decimals: { type: 'integer', minimum: 0, maximum: 3 },
        color,
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    defaultProps: { prefix: '$', suffix: 'B', decimals: 0 },
    enterStyles: ['pop', 'fade'],
    exitStyles: ['fade'],
    colorProps: ['color'],
    refProps: [],
    assetProps: [],
  },
  {
    name: 'Label',
    displayName: 'Label',
    description:
      'A short text tag. Use it to name or explain something on screen in a few words.',
    propsSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 80 }, color },
      required: ['text'],
      additionalProperties: false,
    },
    defaultProps: {},
    enterStyles: ['slide-up', 'fade', 'pop'],
    exitStyles: ['fade'],
    colorProps: ['color'],
    refProps: [],
    assetProps: [],
  },
];
for (const item of seeds) {
  const found = await db
    .select({ id: components.id })
    .from(components)
    .where(eq(components.name, item.name));
  if (found.length === 0) await db.insert(components).values(item);
}
process.exit(0);
