import { Composition, registerRoot } from 'remotion';
import { defaultSpec, type VideoSpec } from '@app/schema';
import { WORLD } from '@app/render';
import { VideoComposition, type RenderAsset } from './video.js';
import { SceneComposition } from './scene.js';
import type { SceneCompositionProps } from './scene.js';

type CompositionProps = {
  spec: VideoSpec;
  assets: Record<string, RenderAsset>;
};
const spec = defaultSpec();

const Root = () => (
  <>
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
    <Composition
      id="SceneDocumentPreview"
      component={SceneComposition}
      durationInFrames={30}
      fps={30}
      width={WORLD.width}
      height={WORLD.height}
      defaultProps={
        {
          document: { components: [], groups: [] },
          definitions: {},
        } satisfies SceneCompositionProps
      }
      calculateMetadata={() => ({
        durationInFrames: 30,
        fps: 30,
        width: WORLD.width,
        height: WORLD.height,
      })}
    />
  </>
);

registerRoot(Root);
export type { CompositionProps };
