# @app/render — shared render semantics (Stage 2D + 3A timeline)

Single source of truth for how a `SceneDocument` looks. Consumed by the
Remotion worker (`SceneComposition`) and the frontend (preview + canvas),
so both renderers interpret the same document identically.

## Contract

- **Renderer keys**: a component definition's `name` IS its renderer key
  (`BUILT_IN_RENDERER_KEYS`). Unknown names render the shared
  "Unsupported component" fallback — never throw.
- **Transform order** (see `style.ts`): position → size → scale →
  rotation → opacity, i.e. `transform: rotate(Rdeg) scale(SX, SY)`,
  positioned via left/top, stacked via zIndex.
- **Visibility**: `visible: false` excludes the instance from the tree.
  `opacity: 0` still renders (transparent). Groups have no visibility
  field; a hidden group (via `isGroupVisible`) excludes its subtree.
- **Paint order** (see `tree.ts`): top-level instances by stable z-order,
  then top-level groups by stable z-order, each group rendering child
  instances then child groups recursively. Ties keep document order.
  Instances with a dangling `groupId` render nowhere (matches editor).
- **References** (see `refs.ts`): `from`/`to` (or any declared ref props)
  hold `ComponentInstance` ids. Missing/unknown/hidden ends → `null`,
  and the caller renders its safe fallback.
- **Geometry** (see `geometry.ts`): axis-aligned world-space boxes;
  rotation never affects bounds. Connector endpoints sit on box edges
  along the center-to-center line.
- **Timeline** (see `timeline.ts`, Stage 3A): frames are canonical
  (`timeline: { fps, durationFrames }`). Timing convention is
  `startFrame <= frame < endFrame` (endFrame = startFrame +
  durationFrames). Out-of-range instances evaluate to `visible: false`
  but are kept (ids/refs stable) for predictable timeline editing.
- **Evaluator** (see `evaluator.ts`, Stage 3A):
  `evaluateSceneAtFrame(document, frame)` is pure and feeds the existing
  render tree. Tracks override base values without mutating the document.
  Supported properties: `position.x/y`, `size.width/height`,
  `transform.rotation/scaleX/scaleY`, `style.opacity`. Easing: `linear`,
  `easeIn`, `easeOut`, `easeInOut`. Segment easing comes from the starting
  keyframe (`A.easing`); unknown names fall back to `linear`.

## Rules

- Pure functions only. No React, no DOM, no I/O.
- Never mutate the input document.
- Deterministic: same document → same tree, every time, everywhere.
- No dependency on `@app/schema` or frontend types; inputs are
  structural so every consumer's types satisfy them.
