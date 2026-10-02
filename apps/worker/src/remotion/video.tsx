import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from 'remotion';
import type { CSSProperties, ReactNode } from 'react';
import type { Scene, VideoSpec } from '@app/schema';

export type RenderAsset = {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
};

type Props = { spec: VideoSpec; assets: Record<string, RenderAsset> };
type SceneProps = Record<string, unknown>;
type SceneComponent = (props: SceneProps) => ReactNode;

const textValue = (props: SceneProps): string =>
  String(props.text ?? props.title ?? props.label ?? '');
const colorValue = (
  value: unknown,
  palette: Record<string, string>,
  fallback: string,
): string => {
  if (typeof value !== 'string') return fallback;
  return value.startsWith('palette:')
    ? (palette[value.slice('palette:'.length)] ?? fallback)
    : value;
};

const Hub: SceneComponent = (props) => (
  <div
    style={{
      width: 250,
      height: 250,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: colorValue(
        props.color,
        props.palette as Record<string, string>,
        '#F5A623',
      ),
      color: '#2B2620',
      fontSize: 38,
      fontWeight: 700,
      boxShadow: props.pulse ? '0 0 0 18px rgba(245,166,35,0.25)' : undefined,
    }}
  >
    {textValue(props)}
  </div>
);
const LogoCard: SceneComponent = (props) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 24,
      padding: '28px 36px',
      borderRadius: 24,
      background: props.variant === 'dark' ? '#20252d' : '#FFFFFF',
      color: props.variant === 'dark' ? '#FFFFFF' : '#20252d',
      fontSize: 42,
      fontWeight: 700,
      boxShadow: '0 18px 50px rgba(0,0,0,0.18)',
    }}
  >
    {typeof (props.logoSrc ?? props.logoAssetIdSrc) === 'string' ? (
      <Img
        src={String(props.logoSrc ?? props.logoAssetIdSrc)}
        style={{ width: 100, height: 100, objectFit: 'contain' }}
      />
    ) : null}
    {textValue(props)}
  </div>
);
const Arrow: SceneComponent = (props) => (
  <div
    style={{
      width: 320,
      height: 18,
      borderRadius: 20,
      background: colorValue(
        props.color,
        props.palette as Record<string, string>,
        '#2B2620',
      ),
      borderTop:
        props.style === 'dashed' ? '6px dashed currentColor' : undefined,
    }}
  />
);
const CounterPill: SceneComponent = (props) => (
  <div
    style={{
      padding: '26px 42px',
      borderRadius: 50,
      background: colorValue(
        props.color,
        props.palette as Record<string, string>,
        '#20252d',
      ),
      color: '#FFFFFF',
      fontSize: 64,
      fontWeight: 800,
    }}
  >
    {String(props.prefix ?? '')}
    {Number(props.to ?? 0).toFixed(Number(props.decimals ?? 0))}
    {String(props.suffix ?? '')}
  </div>
);
const Label: SceneComponent = (props) => (
  <div
    style={{
      padding: '14px 24px',
      borderRadius: 12,
      background: colorValue(
        props.color,
        props.palette as Record<string, string>,
        '#F5A623',
      ),
      color: '#2B2620',
      fontSize: 34,
      fontWeight: 700,
    }}
  >
    {textValue(props)}
  </div>
);
const TitleCard: SceneComponent = (props) => (
  <div
    style={{ fontSize: 96, fontWeight: 700, textAlign: 'center', padding: 48 }}
  >
    {textValue(props)}
  </div>
);
const TextBlock: SceneComponent = (props) => (
  <div
    style={{
      fontSize: 48,
      lineHeight: 1.2,
      maxWidth: '80%',
      textAlign: 'center',
    }}
  >
    {textValue(props)}
  </div>
);
const CodeBlock: SceneComponent = (props) => (
  <pre
    style={{
      margin: 0,
      padding: 32,
      borderRadius: 16,
      background: '#1d2433',
      color: '#f5f7fa',
      fontSize: 30,
      maxWidth: '85%',
      whiteSpace: 'pre-wrap',
    }}
  >
    {textValue(props)}
  </pre>
);

export const componentMap: Record<string, SceneComponent> = {
  Hub,
  LogoCard,
  Arrow,
  CounterPill,
  Label,
  'title-card': TitleCard,
  title: TitleCard,
  text: TextBlock,
  'text-block': TextBlock,
  'diagram-node': Hub,
  node: Hub,
  'code-block': CodeBlock,
  code: CodeBlock,
};

const anchorStyle = (scene: Scene): CSSProperties => ({
  alignItems: scene.position.anchor.startsWith('top')
    ? 'flex-start'
    : scene.position.anchor.startsWith('bottom')
      ? 'flex-end'
      : 'center',
  justifyContent: scene.position.anchor.endsWith('right')
    ? 'flex-end'
    : scene.position.anchor.endsWith('left')
      ? 'flex-start'
      : 'center',
  padding: `${scene.position.offsetY}% ${scene.position.offsetX}%`,
});

const progress = (
  frame: number,
  start: number,
  end: number,
  easing: Scene['enter']['easing'],
): number => {
  const value = Math.max(
    0,
    Math.min(1, (frame - start) / Math.max(1, end - start)),
  );
  if (easing === 'linear') return value;
  if (easing === 'ease-in') return Easing.in(Easing.ease)(value);
  if (easing === 'ease-in-out') return Easing.inOut(Easing.ease)(value);
  if (easing === 'spring')
    return 1 - Math.exp(-7 * value) * Math.cos(value * Math.PI * 2);
  return Easing.out(Easing.ease)(value);
};

const transitionStyle = (
  style: string,
  value: number,
  exit: boolean,
): CSSProperties => {
  const amount = exit ? 1 - value : value;
  if (style === 'pop')
    return { opacity: value, transform: `scale(${0.75 + amount * 0.25})` };
  if (style === 'slide-up')
    return { opacity: value, transform: `translateY(${(1 - amount) * 80}px)` };
  if (style === 'shrink')
    return { opacity: amount, transform: `scale(${0.8 + amount * 0.2})` };
  if (style === 'draw')
    return {
      opacity: value,
      transform: `scaleX(${amount})`,
      transformOrigin: 'left center',
    };
  return { opacity: amount };
};

const SceneLayer = ({
  scene,
  frame,
  fps,
  spec,
  assets,
}: {
  scene: Scene;
  frame: number;
  fps: number;
  spec: VideoSpec;
  assets: Record<string, RenderAsset>;
}) => {
  const startFrame = Math.round(scene.at * fps);
  const endFrame = Math.round((scene.at + scene.duration) * fps);
  if (frame < startFrame || frame >= endFrame) return null;
  const durationFrames = Math.max(1, endFrame - startFrame);
  const localFrame = frame - startFrame;
  const speed = spec.theme.speed;
  const enterFrames = Math.min(
    durationFrames,
    Math.max(1, Math.round((scene.enter.duration * fps) / speed)),
  );
  const exitFrames = scene.exit
    ? Math.min(
        durationFrames,
        Math.max(1, Math.round((scene.exit.duration * fps) / speed)),
      )
    : 0;
  const enterValue = progress(localFrame, 0, enterFrames, scene.enter.easing);
  const exitValue = exitFrames
    ? progress(
        localFrame,
        durationFrames - exitFrames,
        durationFrames,
        scene.exit!.easing,
      )
    : 0;
  const Component = componentMap[scene.component];
  if (!Component)
    throw new Error(`No Remotion component mapped for ${scene.component}`);
  const props: SceneProps = { ...scene.props, palette: spec.theme.palette };
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && value.startsWith('palette:'))
      props[key] = colorValue(value, spec.theme.palette, '#000000');
    if (typeof value === 'string' && assets[value])
      props[`${key}Src`] = staticFile(assets[value].fileName);
  }
  return (
    <AbsoluteFill
      style={{
        ...anchorStyle(scene),
        ...transitionStyle(scene.enter.style, enterValue, false),
        ...(scene.exit
          ? transitionStyle(scene.exit.style, exitValue, true)
          : {}),
        display: 'flex',
      }}
    >
      <Component {...props} />
    </AbsoluteFill>
  );
};

const Background = ({ spec, assets }: Props) => {
  const background = spec.theme.background;
  if (background.type === 'image') {
    const asset = assets[background.assetId];
    if (!asset)
      throw new Error(`Background asset ${background.assetId} is missing`);
    return (
      <Img
        src={staticFile(asset.fileName)}
        style={{
          position: 'absolute',
          width: '100%',
          height: '100%',
          objectFit: background.fit,
        }}
      />
    );
  }
  const style: CSSProperties =
    background.type === 'gradient'
      ? {
          background: `linear-gradient(${background.angle}deg, ${colorValue(background.from, spec.theme.palette, '#000000')}, ${colorValue(background.to, spec.theme.palette, '#FFFFFF')})`,
        }
      : {
          background: colorValue(
            background.color,
            spec.theme.palette,
            '#000000',
          ),
        };
  return <AbsoluteFill style={style} />;
};

const SideVideo = ({ spec, assets }: Props) => {
  if (!spec.sideVideo) return null;
  const asset = assets[spec.sideVideo.assetId];
  if (!asset)
    throw new Error(`Side video asset ${spec.sideVideo.assetId} is missing`);
  const position = spec.sideVideo.position.anchor;
  const horizontal = position.endsWith('right')
    ? { right: `${Math.max(0, spec.sideVideo.position.offsetX)}%` }
    : position.endsWith('left')
      ? { left: `${Math.max(0, -spec.sideVideo.position.offsetX)}%` }
      : { left: '50%', transform: 'translateX(-50%)' };
  const vertical = position.startsWith('top')
    ? { top: `${Math.max(0, spec.sideVideo.position.offsetY)}%` }
    : position.startsWith('bottom')
      ? { bottom: `${Math.max(0, -spec.sideVideo.position.offsetY)}%` }
      : { top: '50%', transform: 'translateY(-50%)' };
  const radius =
    spec.sideVideo.shape === 'circle'
      ? '50%'
      : spec.sideVideo.shape === 'rounded'
        ? 24
        : 0;
  return (
    <OffthreadVideo
      src={staticFile(asset.fileName)}
      muted
      style={{
        position: 'absolute',
        width: `${spec.sideVideo.sizePercent}%`,
        aspectRatio: '1',
        objectFit: 'cover',
        borderRadius: radius,
        ...horizontal,
        ...vertical,
      }}
    />
  );
};

export const VideoComposition = ({ spec, assets }: Props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audio = spec.audioAssetId ? assets[spec.audioAssetId] : undefined;
  return (
    <AbsoluteFill
      style={{
        color: spec.theme.palette.text ?? '#111827',
        fontFamily: spec.theme.fontFamily,
      }}
    >
      <Background spec={spec} assets={assets} />
      {audio ? <Audio src={staticFile(audio.fileName)} /> : null}
      {spec.scenes.map((scene) => (
        <SceneLayer
          key={scene.id}
          scene={scene}
          frame={frame}
          fps={fps}
          spec={spec}
          assets={assets}
        />
      ))}
      <SideVideo spec={spec} assets={assets} />
    </AbsoluteFill>
  );
};
