import {
  isComponentVisibleToUser,
  resolveSceneTimeline,
  type DocumentComponentInstance,
  type DocumentGroup,
  type RegistryComponent,
  type SceneDocument,
} from '@app/schema';
import { AI_CONTEXT_VERSION } from './systemPrompt.js';
import { MAX_AI_PLAN_OPERATIONS } from './operations.js';

/**
 * Selective AI context builder (Stage 4A).
 *
 * Assembles the small, targeted context a scene-editing model needs:
 * scene metadata, the current document (compacted + capped), authorized
 * component definitions (compacted + capped), and operation instructions.
 * Never the repository, never unrelated users' data, never full histories.
 */

export interface AIContextDefinition {
  id: string;
  name: string;
  description: string;
  props: Array<{ name: string; type?: string; enum?: unknown[] }>;
  refProps: string[];
}

export interface AIContextInput {
  document: SceneDocument;
  /** All candidate definitions; visibility is enforced here per user. */
  definitions: Array<
    RegistryComponent & { id: string; userId: string | null; isPublic: boolean }
  >;
  userId: string;
  selection?: { instanceIds?: string[] };
}

export interface AIContext {
  version: typeof AI_CONTEXT_VERSION;
  scene: {
    id: string;
    name: string;
    fps: number;
    durationFrames: number;
    instanceCount: number;
    groupCount: number;
    truncatedInstances: boolean;
    truncatedDefinitions: boolean;
  };
  instances: Array<{
    id: string;
    definition: string;
    label: string | null;
    position: { x: number; y: number };
    size: { width: number; height: number };
    visible: boolean;
    zIndex: number;
    groupId: string | null;
    animation: Array<{ property: string; keyframes: unknown[] }>;
    selected: boolean;
  }>;
  groups: Array<{ id: string; name: string; parentGroupId: string | null }>;
  definitions: AIContextDefinition[];
  instructions: string;
}

export const MAX_AI_CONTEXT_INSTANCES = 80;
export const MAX_AI_CONTEXT_DEFINITIONS = 40;
export const MAX_AI_CONTEXT_PROPS = 30;
export const MAX_AI_CONTEXT_KEYFRAMES = 20;

const instanceLabelOf = (instance: DocumentComponentInstance): string | null => {
  const props = (instance.props ?? {}) as Record<string, unknown>;
  for (const key of ['text', 'label', 'title']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
};

const compactProps = (
  propsSchema: unknown,
): Array<{ name: string; type?: string; enum?: unknown[] }> => {
  if (!propsSchema || typeof propsSchema !== 'object') return [];
  const properties = (propsSchema as { properties?: Record<string, { type?: unknown; enum?: unknown }> })
    .properties;
  if (!properties || typeof properties !== 'object') return [];
  return Object.entries(properties)
    .slice(0, MAX_AI_CONTEXT_PROPS)
    .map(([name, schema]) => ({
      name,
      ...(typeof schema?.type === 'string' ? { type: schema.type } : {}),
      ...(Array.isArray(schema?.enum) ? { enum: schema.enum } : {}),
    }));
};

export const buildAIContext = (input: AIContextInput): AIContext => {
  const timeline = resolveSceneTimeline(input.document);
  const selected = new Set(input.selection?.instanceIds ?? []);

  const instances = input.document.components.slice(0, MAX_AI_CONTEXT_INSTANCES);
  const truncatedInstances =
    input.document.components.length > MAX_AI_CONTEXT_INSTANCES;

  const visibleDefinitions = input.definitions
    .filter((definition) => isComponentVisibleToUser(definition, input.userId))
    .slice(0, MAX_AI_CONTEXT_DEFINITIONS);
  const truncatedDefinitions =
    input.definitions.filter((definition) =>
      isComponentVisibleToUser(definition, input.userId),
    ).length > MAX_AI_CONTEXT_DEFINITIONS;

  return {
    version: AI_CONTEXT_VERSION,
    scene: {
      id: input.document.id,
      name: input.document.name,
      fps: timeline.fps,
      durationFrames: timeline.durationFrames,
      instanceCount: input.document.components.length,
      groupCount: input.document.groups.length,
      truncatedInstances,
      truncatedDefinitions,
    },
    instances: instances.map((instance: DocumentComponentInstance) => ({
      id: instance.id,
      definition:
        input.definitions.find((d) => d.id === instance.componentDefinitionId)?.name ??
        'unknown',
      label: instanceLabelOf(instance),
      position: instance.position,
      size: instance.size,
      visible: instance.visible,
      zIndex: instance.zIndex,
      groupId: instance.groupId ?? null,
      animation: (instance.animation?.tracks ?? []).map((track) => ({
        property: track.property,
        keyframes: track.keyframes.slice(0, MAX_AI_CONTEXT_KEYFRAMES),
      })),
      selected: selected.has(instance.id),
    })),
    groups: (input.document.groups as DocumentGroup[]).map((group) => ({
      id: group.id,
      name: group.name,
      parentGroupId: group.parentGroupId ?? null,
    })),
    definitions: visibleDefinitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      props: compactProps(definition.propsSchema),
      refProps: [...(definition.refProps ?? [])],
    })),
    instructions: [
      `Respond with a JSON operation plan: {"operations": [...]} (max ${MAX_AI_PLAN_OPERATIONS} operations).`,
      'Available operation types: createInstance, updateInstance, deleteInstance, createGroup, deleteGroup, moveInstance, resizeInstance, updateProps, updateStyle, setVisibility, setZIndex, setReference, addAnimationTrack, addKeyframe, deleteKeyframe.',
      'createInstance requires a unique clientKey and an exact definitionName from the registry above.',
      'Reference other instances by their id, or by clientKey for instances created earlier in the same plan.',
      'Animation keyframes use integer frames within the scene durationFrames and one of: linear, easeIn, easeOut, easeInOut.',
      'Return an empty operations array when the request cannot be expressed.',
    ].join('\n'),
  };
};
