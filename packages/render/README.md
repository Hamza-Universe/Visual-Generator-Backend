# @app/render — shared render semantics (Stage 2D + 3A timeline + 4C layout)

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
- **Layout** (see `layout.ts`, Stage 4C): `resolveLayout(request)` (alias
  `applyLayout`) is the pure, deterministic arrangement engine: horizontal,
  vertical, grid, center, stack, align, distribute, relationship flow,
  text-aware sizing (`fitText`), canvas constraints, overlap detection, and
  bounded collision resolution. It reuses `boundsOf`/`unionBounds`/
  `connectorEndpoints`, emits minimal geometry deltas, and never mutates the
  document. Scenes are layered compositions: overlapping boxes are only ever
  separated when collision resolution is explicitly requested, and instances
  marked `style.layoutOverlap = 'intentional'` are never separated.
  Connectors (instances carrying the full ref-props pair) are derived
  geometry — excluded from arrangement and re-anchored to the segment box of
  their endpoints after every pass. No randomness or clocks: document-order
  tie-breaks, 2-decimal rounding, bounded passes — same input → same output.

## Rules

- Pure functions only. No React, no DOM, no I/O.
- Never mutate the input document.
- Deterministic: same document → same tree, every time, everywhere.
- No dependency on `@app/schema` or frontend types; inputs are
  structural so every consumer's types satisfy them.
