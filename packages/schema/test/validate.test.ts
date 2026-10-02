import { describe, expect, it } from 'vitest';
import {
  defaultSpec,
  type RegistryComponent,
  validateSpec,
} from '../src/index.js';

const component = (
  overrides: Partial<RegistryComponent> = {},
): RegistryComponent => ({
  name: 'Label',
  description: 'label',
  propsSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, color: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  defaultProps: {},
  enterStyles: ['fade'],
  exitStyles: ['fade'],
  colorProps: ['color'],
  refProps: [],
  assetProps: [],
  ...overrides,
});
const context = (item = component()): Parameters<typeof validateSpec>[1] => ({
  registry: new Map([[item.name, item]]),
  assetExists: () => true,
  assetKind: () => 'audio',
});
const valid = () => ({
  ...defaultSpec(),
  meta: { ...defaultSpec().meta, durationInSeconds: 5 },
  scenes: [
    {
      id: 'label',
      component: 'Label',
      at: 0,
      duration: 2,
      props: { text: 'hello' },
      enter: { style: 'fade' },
    },
  ],
});

describe('validateSpec', () => {
  it('accepts a valid spec', () =>
    expect(validateSpec(valid(), context())).toEqual([]));
  it.each([
    [
      'DUPLICATE_SCENE_ID',
      () => ({
        ...valid(),
        scenes: [valid().scenes[0], { ...valid().scenes[0] }],
      }),
    ],
    [
      'UNKNOWN_COMPONENT',
      () => ({
        ...valid(),
        scenes: [{ ...valid().scenes[0], component: 'Missing' }],
      }),
    ],
    [
      'INVALID_PROPS',
      () => ({ ...valid(), scenes: [{ ...valid().scenes[0], props: {} }] }),
    ],
    [
      'UNKNOWN_ENTER_STYLE',
      () => ({
        ...valid(),
        scenes: [{ ...valid().scenes[0], enter: { style: 'pop' } }],
      }),
    ],
    [
      'UNKNOWN_EXIT_STYLE',
      () => ({
        ...valid(),
        scenes: [{ ...valid().scenes[0], exit: { style: 'pop' } }],
      }),
    ],
    [
      'SCENE_OUT_OF_RANGE',
      () => ({ ...valid(), scenes: [{ ...valid().scenes[0], duration: 6 }] }),
    ],
    [
      'TRANSITIONS_TOO_LONG',
      () => ({
        ...valid(),
        scenes: [
          {
            ...valid().scenes[0],
            duration: 0.5,
            enter: { style: 'fade', duration: 1 },
          },
        ],
      }),
    ],
    [
      'UNKNOWN_PALETTE_COLOR',
      () => ({
        ...valid(),
        scenes: [{ ...valid().scenes[0], color: 'palette:nope' }],
      }),
    ],
    [
      'BAD_REFERENCE',
      () => ({
        ...valid(),
        scenes: [{ ...valid().scenes[0], props: { text: 'x' } }],
      }),
    ],
  ])('reports %s', (code, make) => {
    const item =
      code === 'BAD_REFERENCE'
        ? component({ refProps: ['from'] })
        : component();
    const spec =
      code === 'BAD_REFERENCE'
        ? {
            ...make(),
            scenes: [
              { ...make().scenes[0], props: { text: 'x', from: 'missing' } },
            ],
          }
        : make();
    expect(
      validateSpec(spec, context(item)).some((issue) => issue.code === code),
    ).toBe(true);
  });
  it('reports unknown assets', () =>
    expect(
      validateSpec(
        { ...valid(), audioAssetId: '00000000-0000-0000-0000-000000000001' },
        { ...context(), assetExists: () => false },
      ).some((x) => x.code === 'UNKNOWN_ASSET'),
    ).toBe(true));
});
