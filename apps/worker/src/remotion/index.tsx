import { Composition, registerRoot } from 'remotion';
import { defaultSpec, type VideoSpec } from '@app/schema';
import { VideoComposition, type RenderAsset } from './video.js';

type CompositionProps = {
  spec: VideoSpec;
  assets: Record<string, RenderAsset>;
};
const spec = defaultSpec();

const Root = () => (
  <Composition
    id="VisualDiagram"
    component={VideoComposition}
    durationInFrames={spec.meta.durationInSeconds * spec.meta.fps}
    fps={spec.meta.fps}
    width={spec.meta.width}
    height={spec.meta.height}
    defaultProps={{ spec, assets: {} }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.ceil(
        props.spec.meta.durationInSeconds * props.spec.meta.fps,
      ),
      fps: props.spec.meta.fps,
      width: props.spec.meta.width,
      height: props.spec.meta.height,
    })}
  />
);

registerRoot(Root);
export type { CompositionProps };
