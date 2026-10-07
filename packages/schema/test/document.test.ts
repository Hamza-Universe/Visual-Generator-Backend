import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AnimationSchema,
  CreateGroupInputSchema,
  CreateInstanceInputSchema,
  InstancePositionSchema,
  SceneDocumentSchema,
  SizeSchema,
  StyleSchema,
  TimingSchema,
  TransformSchema,
  assertSameScene,
  assertValidInstanceReferences,
  buildGroupTree,
  isComponentVisibleToUser,
  resolveInstanceProps,
  wouldCreateGroupCycle,
} from '../src/document.js';

const labelDefinition = {
  propsSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  defaultProps: { text: 'hello' },
};

describe('Stage 1 document structures', () => {
  it('accepts the canonical position/size/transform/style/timing shapes', () => {
    expect(InstancePositionSchema.parse({ x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
    expect(SizeSchema.parse({ width: 400, height: 200 })).toEqual({ width: 400, height: 200 });
    expect(TransformSchema.parse({ rotation: 0, scaleX: 1, scaleY: 1 })).toEqual({
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    });
    expect(StyleSchema.parse({ opacity: 1 })).toMatchObject({ opacity: 1 });
    expect(TimingSchema.parse({ start: 0, duration: 2 })).toEqual({ start: 0, duration: 2 });
    expect(AnimationSchema.parse({ enter: [], exit: [], keyframes: [] })).toEqual({
      enter: [],
      exit: [],
      keyframes: [],
    });
  });

  it('accepts a full scene document with nested groups', () => {
    const sceneId = randomUUID();
    const projectId = randomUUID();
    const defId = randomUUID();
    const groupId = randomUUID();
    const document = SceneDocumentSchema.parse({
      id: sceneId,
      projectId,
      name: 'Scene 1',
      components: [
        {
          id: randomUUID(),
          sceneId,
          componentDefinitionId: defId,
          props: { text: 'F' },
        },
        {
          id: randomUUID(),
          sceneId,
          componentDefinitionId: defId,
          groupId,
          props: { text: 'ma' },
        },
      ],
      groups: [
        {
          id: groupId,
          sceneId,
          name: 'Equation',
        },
      ],
    });
    expect(document.components).toHaveLength(2);
    expect(document.groups).toHaveLength(1);
  });

  it('validates create payloads', () => {
    expect(
      CreateInstanceInputSchema.parse({
        componentDefinitionId: randomUUID(),
        props: { text: 'F' },
      }).props,
    ).toEqual({ text: 'F' });
    expect(
      CreateGroupInputSchema.parse({ name: 'Equation' }).name,
    ).toBe('Equation');
  });
});

describe('component props validation', () => {
  it('applies default props when none are supplied', () => {
    expect(resolveInstanceProps(labelDefinition, {})).toEqual({ text: 'hello' });
  });

  it('merges supplied props over defaults', () => {
    expect(resolveInstanceProps(labelDefinition, { text: 'F' })).toEqual({ text: 'F' });
  });

  it('rejects invalid props', () => {
    try {
      resolveInstanceProps(labelDefinition, { text: 42 as never });
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_PROPS');
    }
  });

  it('rejects unknown props when additionalProperties is false', () => {
    try {
      resolveInstanceProps(labelDefinition, { nope: true });
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_PROPS');
    }
  });
});

describe('generic component references', () => {
  const refProps = ['from', 'to'];
  const sceneIds = ['inst-a', 'inst-b'];

  it('accepts references to instances in the same scene', () => {
    expect(() =>
      assertValidInstanceReferences(refProps, { from: 'inst-a', to: 'inst-b' }, sceneIds),
    ).not.toThrow();
  });

  it('treats empty values as unset', () => {
    expect(() =>
      assertValidInstanceReferences(refProps, { from: '', to: '' }, sceneIds),
    ).not.toThrow();
    expect(() =>
      assertValidInstanceReferences(refProps, {}, sceneIds),
    ).not.toThrow();
  });

  it('rejects references outside the scene', () => {
    try {
      assertValidInstanceReferences(refProps, { from: 'inst-a', to: 'other-scene' }, sceneIds);
      expect.unreachable();
    } catch (error) {
      expect((error as { code?: string }).code).toBe('BAD_REFERENCE');
    }
  });

  it('does nothing when the definition declares no reference props', () => {
    expect(() =>
      assertValidInstanceReferences([], { from: 'anything' }, sceneIds),
    ).not.toThrow();
  });
});

describe('public/private component visibility', () => {
  it('shows public components to any user', () => {
    expect(isComponentVisibleToUser({ userId: 'owner', isPublic: true }, 'other')).toBe(true);
    expect(isComponentVisibleToUser({ userId: null, isPublic: true }, 'other')).toBe(true);
  });

  it('shows private components only to the owner', () => {
    expect(isComponentVisibleToUser({ userId: 'owner', isPublic: false }, 'owner')).toBe(true);
    expect(isComponentVisibleToUser({ userId: 'owner', isPublic: false }, 'other')).toBe(false);
  });
});

describe('group/scene integrity', () => {
  it('rejects cross-scene references', () => {
    expect(() =>
      assertSameScene('scene-a', [{ sceneId: 'scene-b', label: 'Group' }]),
    ).toThrow();
    expect(() =>
      assertSameScene('scene-a', [{ sceneId: 'scene-a', label: 'Group' }]),
    ).not.toThrow();
  });

  it('builds nested group trees', () => {
    const tree = buildGroupTree([
      { id: 'a', sceneId: 's', name: 'A', zIndex: 0 },
      { id: 'b', sceneId: 's', parentGroupId: 'a', name: 'B', zIndex: 0 },
    ]);
    expect(tree).toHaveLength(1);
    expect((tree[0].children as unknown[])).toHaveLength(1);
  });

  it('detects group cycles', () => {
    const groups = [
      { id: 'a', parentGroupId: null as string | null },
      { id: 'b', parentGroupId: 'a' },
    ];
    expect(wouldCreateGroupCycle(groups, 'a', 'b')).toBe(true);
    expect(wouldCreateGroupCycle(groups, 'b', null)).toBe(false);
    expect(wouldCreateGroupCycle(groups, 'b', 'a')).toBe(false);
  });
});
