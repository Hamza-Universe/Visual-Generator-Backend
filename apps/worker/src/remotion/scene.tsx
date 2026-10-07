import type { CSSProperties, ReactNode } from 'react';
import {
  WORLD,
  buildRenderTree,
  connectorEndpointsFor,
  evaluateSceneAtFrame,
  normalizeFrame,
  resolveTimeline,
  type RenderableDocument,
  type RenderNode,
  type RenderTreeNode,
} from '@app/render';

/**
 * Deterministic Remotion preview path for a SceneDocument (Stage 2D).
 *
 * Consumes the shared render contract (@app/render) — the same tree,
 * styles, keys, references and geometry as the editor — so a scene looks
 * identical in the frontend preview and in Remotion output.
 *
 * Stage 3B: this component is frame-aware. It evaluates the document at
 * `props.frame` (default 0) via the Stage 3A evaluator, then builds the
 * existing render tree from the evaluated scene. Connectors resolve
 * against evaluated components, so animated references are followed.
 *
 * Deliberately free of `remotion` imports (plain divs/SVG only) so the
 * mapping stays unit-testable with react-dom/server. The Remotion
 * frame source (`useCurrentFrame`) lives in `./sceneFrame.js`, which
 * delegates here — keeping evaluation logic separate from renderer logic.
 */

export type SceneDefinitions = Record<string, string>;

export interface SceneCompositionProps {
  /** Remotion requires all composition props to be optional; empty scene is the default. */
  document?: RenderableDocument;
  /** componentDefinitionId → definition `name` (the renderer key). */
  definitions?: SceneDefinitions;
  /**
   * Frame to evaluate (Stage 3B). The frame-aware wrapper (`sceneFrame.js`)
   * supplies Remotion's current frame; direct renders default to frame 0,
   * which keeps legacy static documents fully visible.
   */
  frame?: number;
  width?: number;
  height?: number;
  background?: string;
  /**
   * Staged production assets by id (Stage 3E). Resolved and staged by the
   * worker using the existing asset mechanisms; current built-in renderers
   * ignore it, keeping asset-backed components forward-compatible without
   * changing component semantics.
   */
  assets?: Record<string, { id: string; kind: string; fileName: string; mimeType: string }>;
}

type RendererProps = {
  node: RenderNode;
  document: RenderableDocument;
  definitionName: string;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const paletteColor = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('palette:')) return undefined;
  return value;
};

const fillBox: CSSProperties = { width: '100%', height: '100%' };

const LabelRenderer = ({ node }: RendererProps): ReactNode => {
  const props = asRecord(node.instance.props);
  return (
    <div
      style={{
        ...fillBox,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 30,
        fontWeight: 800,
        letterSpacing: -0.5,
        overflow: 'visible',
        whiteSpace: 'nowrap',
        color: paletteColor(props.color) ?? '#2B2620',
      }}
    >
      {asString(props.text, 'Label')}
    </div>
  );
};

const CounterPillRenderer = ({ node }: RendererProps): ReactNode => {
  const props = asRecord(node.instance.props);
  const to = asNumber(props.to, asNumber(props.from, 0));
  const decimals = Math.min(3, Math.max(0, Math.round(asNumber(props.decimals, 0))));
  return (
    <div
      style={{
        ...fillBox,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 30,
        fontWeight: 800,
        background: '#fff',
        border: `3px solid ${paletteColor(props.color) ?? '#1F3A93'}`,
        borderRadius: 999,
        overflow: 'hidden',
      }}
    >
      {`${asString(props.prefix, '')}${to.toFixed(decimals)}${asString(props.suffix, '')}`}
    </div>
  );
};

const HubRenderer = ({ node }: RendererProps): ReactNode => {
  const props = asRecord(node.instance.props);
  return (
    <div
      style={{
        ...fillBox,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 20,
        fontWeight: 800,
        boxShadow: '0 8px 24px rgba(16,24,40,0.2)',
        overflow: 'hidden',
        background: paletteColor(props.color) ?? '#F5A623',
      }}
    >
      <span>{asString(props.label, '')}</span>
    </div>
  );
};

const ArrowRenderer = ({ node, document }: RendererProps): ReactNode => {
  const { instance } = node;
  const props = asRecord(instance.props);
  const dashed = asString(props.style, 'dashed') !== 'solid';
  const color = paletteColor(props.color) ?? '#2B2620';
  const markerId = `arrowhead-${instance.id}`;
  const marker = (
    <defs>
      <marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
        <path d="M0,0 L8,3 L0,6 Z" fill={color} />
      </marker>
    </defs>
  );
  const endpoints = connectorEndpointsFor(document.components, instance);
  if (endpoints) {
    const { p1, p2 } = endpoints;
    const pad = 16;
    const originX = Math.min(p1.x, p2.x) - pad;
    const originY = Math.min(p1.y, p2.y) - pad;
    const w = Math.max(1, Math.max(p1.x, p2.x) - originX + pad);
    const h = Math.max(1, Math.max(p1.y, p2.y) - originY + pad);
    return (
      <svg
        width={w}
        height={h}
        viewBox={`${originX} ${originY} ${w} ${h}`}
        style={{
          position: 'absolute',
          left: originX - instance.position.x,
          top: originY - instance.position.y,
          overflow: 'visible',
          display: 'block',
        }}
      >
        {marker}
        <line
          x1={p1.x}
          y1={p1.y}
          x2={p2.x}
          y2={p2.y}
          stroke={color}
          strokeWidth={3}
          strokeDasharray={dashed ? '10 7' : undefined}
          markerEnd={`url(#${markerId})`}
        />
      </svg>
    );
  }
  const w = Math.max(1, instance.size.width);
  const h = Math.max(1, instance.size.height);
  const midY = h / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
      {marker}
      <line
        x1={8}
        y1={midY}
        x2={Math.max(9, w - 12)}
        y2={midY}
        stroke={color}
        strokeWidth={3}
        strokeDasharray={dashed ? '10 7' : undefined}
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
};

const LogoCardRenderer = ({ node }: RendererProps): ReactNode => {
  const props = asRecord(node.instance.props);
  const dark = asString(props.variant, 'light') === 'dark';
  const label = asString(props.label, '');
  return (
    <div
      style={{
        ...fillBox,
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        fontSize: 22,
        fontWeight: 800,
        border: '1px solid #e5e7eb',
        overflow: 'hidden',
        background: dark ? '#1c2330' : '#fff',
        color: dark ? '#f3f5f7' : '#141821',
      }}
    >
      <span>{label || 'Logo'}</span>
      {label === '' ? (
        <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>asset card</span>
      ) : null}
    </div>
  );
};

/** Graceful fallback: unknown keys never crash the scene. */
const UnsupportedSceneComponent = ({ definitionName }: { definitionName: string }): ReactNode => (
  <div
    data-unsupported={definitionName}
    style={{
      width: '100%',
      height: '100%',
      minWidth: 180,
      minHeight: 64,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      border: '2px dashed #d9a021',
      borderRadius: 8,
      background: '#fff8e6',
      color: '#7a5a12',
      fontSize: 12,
      padding: 8,
      overflow: 'hidden',
    }}
  >
    <strong>Unsupported component</strong>
    <span>{definitionName}</span>
  </div>
);

const sceneRenderers: Record<string, (props: RendererProps) => ReactNode> = {
  Label: LabelRenderer,
  CounterPill: CounterPillRenderer,
  Hub: HubRenderer,
  Arrow: ArrowRenderer,
  LogoCard: LogoCardRenderer,
};

export const resolveSceneRenderer = (definitionName: string) =>
  sceneRenderers[definitionName] ?? null;

const definitionNameOf = (
  definitions: SceneDefinitions,
  instance: { componentDefinitionId?: string },
): string => definitions[instance.componentDefinitionId ?? ''] ?? 'unknown';

const nodeStyle = (node: RenderNode): CSSProperties => ({
  position: 'absolute',
  left: node.style.left,
  top: node.style.top,
  width: node.style.width,
  height: node.style.height,
  opacity: node.style.opacity,
  transform: node.style.transform,
  zIndex: node.style.zIndex,
});

const SceneInstanceNode = ({
  node,
  document,
  definitionName,
}: {
  node: RenderNode;
  document: RenderableDocument;
  definitionName: string;
}) => {
  const Renderer = sceneRenderers[definitionName];
  return (
    <div
      data-instance-id={node.instance.id}
      data-definition={definitionName}
      style={nodeStyle(node)}
    >
      {Renderer ? (
        <Renderer node={node} document={document} definitionName={definitionName} />
      ) : (
        <UnsupportedSceneComponent definitionName={definitionName} />
      )}
    </div>
  );
};

const SceneGroupNode = ({
  group,
  children,
  document,
  definitions,
}: {
  group: { id: string; zIndex: number };
  children: RenderTreeNode[];
  document: RenderableDocument;
  definitions: SceneDefinitions;
}): ReactNode => (
  <div data-group-id={group.id} style={{ position: 'absolute', inset: 0, zIndex: group.zIndex }}>
    {children.map((child) =>
      child.type === 'instance' ? (
        <SceneInstanceNode
          key={child.node.instance.id}
          node={child.node}
          document={document}
          definitionName={definitionNameOf(definitions, child.node.instance)}
        />
      ) : (
        <SceneGroupNode
          key={child.group.id}
          group={child.group}
          children={child.children}
          document={document}
          definitions={definitions}
        />
      ),
    )}
  </div>
);

/**
 * Composition config derived from the document timeline (Stage 3B).
 * fps and durationInFrames come from `document.timeline` — never hard-coded.
 * Invalid/absent timelines fall back to the schema defaults (30fps/300f).
 */
export const resolveSceneCompositionConfig = (document?: {
  timeline?: { fps?: unknown; durationFrames?: unknown } | null;
  duration?: unknown;
  components?: unknown;
  groups?: unknown;
}): { fps: number; durationInFrames: number; width: number; height: number } => {
  const timeline = resolveTimeline(document ?? {});
  return {
    fps: timeline.fps,
    durationInFrames: timeline.durationFrames,
    width: WORLD.width,
    height: WORLD.height,
  };
};

export const SceneComposition = ({
  document = { components: [], groups: [] },
  definitions = {},
  frame = 0,
  width = WORLD.width,
  height = WORLD.height,
  background = '#ffffff',
}: SceneCompositionProps): ReactNode => {
  // Stage 3B: Remotion frame → Stage 3A evaluator → existing render tree.
  // The evaluated scene (not the stored document) feeds the tree AND the
  // per-instance renderers, so timing, animated values, and animated
  // connectors all agree. The stored document is never mutated.
  const evaluatedScene = evaluateSceneAtFrame(document, normalizeFrame(frame));
  const evaluatedDocument = {
    components: evaluatedScene.components,
    groups: evaluatedScene.groups,
  };
  const tree = buildRenderTree(evaluatedDocument);
  return (
    <div
      data-scene-document={true}
      style={{ position: 'relative', width, height, background, overflow: 'hidden' }}
    >
      {tree.map((root) =>
        root.type === 'instance' ? (
          <SceneInstanceNode
            key={root.node.instance.id}
            node={root.node}
            document={evaluatedDocument}
            definitionName={definitionNameOf(definitions, root.node.instance)}
          />
        ) : (
          <SceneGroupNode
            key={root.group.id}
            group={root.group}
            children={root.children}
            document={evaluatedDocument}
            definitions={definitions}
          />
        ),
      )}
    </div>
  );
};
