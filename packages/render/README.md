# @app/render — shared render semantics (Stage 2D + 3A timeline + 4C layout + 4D motion)

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
- **Motion** (see `motion.ts`, Stage 4D): `compileMotion(request)` compiles
  high-level motion intent (primitive + options + timing + choreography) into
  ordinary animation tracks for the existing evaluator — no second timeline,
  no renderer changes. Fully deterministic (no clocks, no randomness), bounds
  every numeric input, and reports structured `MotionIssue`s instead of
  throwing. See the dedicated section below.

## Rules

- Pure functions only. No React, no DOM, no I/O.
- Never mutate the input document.
- Deterministic: same document → same tree, every time, everywhere.
- No dependency on `@app/schema` or frontend types; inputs are
  structural so every consumer's types satisfy them.

## Motion design engine (Stage 4D, `motion.ts`)

`compileMotion(request)` turns **motion intent** — a semantic primitive,
options, timing, and choreography — into ordinary `AnimationTrack`s for the
existing timeline evaluator. It is a compiler, not a second pipeline: no new
animation model, no renderer changes, no direct keyframe input from callers.
Stored document base values are never modified; tracks override them at
evaluation time, exactly like hand-authored keyframes.

```
primitive + options + timing + choreography + targets + timeline + canvas
  → compileMotion() → { targets: [{ id, tracks, windows }], issues }
  → existing document mutation (animation.tracks) → evaluator → render tree
```

### Taxonomy

- **Supported (16)** — compiled to real tracks on the 8 animatable
  properties: entrances `fadeIn`, `scaleIn`, `slideIn`, `popIn`; exits
  `fadeOut`, `scaleOut`, `slideOut`; transforms `move`, `scale`, `resize`,
  `rotate`, `fade`; emphasis `pulse`, `bounce`, `shake`, `scaleEmphasis`.
- **Declared but unsupported (16)** — `wipeIn`, `wipeOut`, `revealIn`,
  `drawIn`, `typeIn`, `blurIn`, `blurOut`, `colorChange`, `textChange`,
  `shapeChange`, `morph`, `cameraPan`, `cameraZoom`, `cameraFocus`,
  `cameraShake`, `cameraFollow`. The vocabulary exists so a model can
  reference these effects, but the render pipeline has no honest way to
  express them (masks, blur filters, text reveal, stroke drawing, viewport
  transforms) — they fail with `MOTION_UNSUPPORTED_RENDER_CAPABILITY`
  instead of being faked.
- Unknown names (not in either list) fail with `MOTION_UNSUPPORTED_PRIMITIVE`.
  Helpers: `isMotionPrimitiveSupported`, `isDeclaredMotionPrimitive`.

### Timing

`resolveMotionTiming(timing, { fps, durationFrames }, issues)` accepts
`start` / `delay` / `duration` / `end` in **seconds**, converts with
`frames = Math.max(0, Math.round(seconds * fps))`, and requires the whole
window to fit inside the scene duration. `end` is redundant information: if
both `duration` and `end` are given they must agree
(`end == start + delay + duration`) or `MOTION_INVALID_TIMING` is reported.
Defaults: `start = 0`, `delay = 0`, `duration = MOTION_DEFAULT_DURATION_SECONDS`
(0.5 s). Non-finite, negative, or out-of-range values are rejected — never
clamped silently. Limits: `MOTION_MAX_DURATION_SECONDS` (30),
`MOTION_MAX_START_SECONDS` / `MOTION_MAX_DELAY_SECONDS` (600 each).

### Options, easing, spring

Each primitive declares its allowed option keys (`MOTION_OPTION_KEYS`);
unknown keys are rejected with `MOTION_INVALID_OPTION`. Easing names are
restricted to the shared enum: `linear`, `easeIn`, `easeOut`, `easeInOut`,
`easeInQuad`, `easeOutQuad`, `easeInCubic`, `easeOutCubic`, `easeInBack`,
`easeOutBack` — named constants only, no raw cubic-bezier input.
`options.spring` (`{ mass, stiffness, damping }`, bounded by
`MOTION_SPRING_BOUNDS`, defaults `MOTION_SPRING_DEFAULTS`) replaces a linear
segment with a deterministic critically-damped-ish sample series
(`springKeyframes`, at most `MOTION_SPRING_MAX_SAMPLES` = 48 keyframes,
hitting both endpoints exactly). Spring is additive to easing selection and
never required: every primitive works without it.

`slideIn`/`slideOut` distances are **derived from Stage 4C layout geometry**
when `distance` is not given: the gap between the instance's bounds and the
canvas edge in the requested direction, clamped to
`[MOTION_MIN_DERIVED_DISTANCE (48), MOTION_MAX_DISTANCE (4000)]`. Callers
pass the resolved canvas (the engine defaults to the canonical `WORLD` box);
no start/end coordinates ever come from the model.

### Choreography

`resolveMotionChoreography` produces `{ mode, order, stagger, overlap }`.
Defaults: `mode: 'parallel'`, `order: 'forward'`, `stagger: 0.1`,
`overlap: 0.5` (only `stagger`/`overlap` are used by their matching modes).

`motionRanks(count, order)` assigns each target a rank = the number of
targets ordered strictly before it, so equal keys get equal ranks
(simultaneous starts):

| order     | keys                    | ranks (n = 5)   |
| --------- | ----------------------- | --------------- |
| `forward` | `i`                     | `[0,1,2,3,4]`   |
| `reverse` | `-i`                    | `[4,3,2,1,0]`   |
| `centerOut` | `abs(i - center)`     | `[3,1,0,1,3]`   |
| `edgesIn` | `-abs(i - center)`      | `[0,2,4,2,0]`   |

`motionOffsetSeconds(rank, choreography, duration)`:
`parallel → 0`, `stagger → rank * stagger`,
`sequence → rank * (duration + stagger)`,
`overlap → rank * max(0, duration - overlap)`.
Offsets are deterministic; a per-target window that would land beyond the
scene duration is reported as `MOTION_INVALID_TIMING` and produces no
keyframes — nothing is silently trimmed or wrapped. Ties break on
plan/target order — no randomness anywhere.

### Windows, merging, conflicts

- A motion **window** is `[startFrame, endFrame]` (inclusive) per
  (instance, property). The window fully owns its keyframes: recompiling
  **replaces** stored keyframes inside the window and **preserves** every
  keyframe outside it, so applying twice yields the same document
  (idempotent) and no motion id needs to be persisted.
- `mergeMotionTracks(existing, compiled, windows)` performs that merge and
  normalizes (sorts, dedupes keeping the last, drops non-finite) exactly
  like the evaluator normalizes hand-authored tracks; unknown/non-animatable
  existing entries pass through untouched.
- **Conflict rule** (`findMotionConflicts`, `motionWindowsOverlap`):
  two motion items on the same target + property conflict when their windows
  overlap with positive length (`a.start < b.end && b.start < a.end`) —
  windows may touch at one boundary frame. A raw `addKeyframe` /
  `addAnimationTrack` / `deleteKeyframe` frame inside a motion window
  (inclusive) conflicts with that motion. Detection is **order-independent**
  (accumulated items + a plan-wide raw-op pre-scan) and reported as
  `MOTION_CONFLICT`; the engine never silently picks a winner.
- Motion always compiles from document **base** values, never from another
  animation's interpolated values.

### Compilation details

- Round every emitted value to 2 decimals (the Stage 4C geometry
  convention); segments whose rounded start equals rounded end emit no
  keyframes (the property simply isn't animated).
- Segment easing comes from the **first** keyframe of each pair, matching
  the evaluator's convention; the closing keyframe is `linear`.
- Emphasis patterns (`pulse`, `bounce`, `shake`, `scaleEmphasis`) split the
  window into an even number of spans and always land the final keyframe on
  the window end, returning the property to its base value.
- All values are finite: NaN/Infinity in inputs is
  `MOTION_INVALID_TIMING`/`MOTION_INVALID_OPTION`; the compiler never emits
  a non-finite keyframe (`MOTION_COMPILATION_ERROR` is a defensive
  post-validation guard).

### Verification

`verifyMotionApplication(request)` recompiles the intent against the
**post-apply** document (targets carry the tracks actually stored) and diffs
stored keyframes against the fresh expectations inside every motion window:
track presence, frame presence, value agreement within
`MOTION_VALUE_TOLERANCE` (0.01), finiteness, scene-duration bounds, and
`style.opacity ∈ [0, 1]`. Issues are capped at `MOTION_MAX_ISSUES` (12).
The API layer runs this after `verifySceneExpectations` so a plan cannot
self-declare success.

### Error codes & limits

`MOTION_ISSUE_CODES`: `MOTION_TARGET_NOT_FOUND`, `MOTION_UNSUPPORTED_PRIMITIVE`,
`MOTION_UNSUPPORTED_RENDER_CAPABILITY`, `MOTION_INVALID_TIMING`,
`MOTION_INVALID_OPTION`, `MOTION_CONFLICT`, `MOTION_COMPILATION_ERROR`,
`MOTION_TARGET_LIMIT`. Every issue is `{ path, code, message }` with `path`
relative to the motion operation.

Server-owned bounds (never caller-configurable): scope
`MOTION_MAX_RESOLVED_TARGETS` (500), option keys `MOTION_MAX_OPTION_KEYS`
(16), cycles `MOTION_MAX_CYCLES` (10), resize `MOTION_MAX_RESIZE` (8000),
rotation `MOTION_MAX_ROTATE_DEGREES`/`MOTION_MAX_ROTATE_CYCLES`,
scale `MOTION_MAX_SCALE_FACTOR` (100), shake `MOTION_MAX_SHAKE_DISTANCE`
(1000), bounce `MOTION_MAX_BOUNCE_HEIGHT` (4000), stagger/overlap
`MOTION_MAX_CHOREOGRAPHY_*` (10 s each).

### Guarantees

Same inputs → same output, everywhere: no `Date.now`, no `Math.random`, no
UUIDs, no environment APIs; stable ordering (input order + explicit ranks);
inputs are never mutated. The engine runs identically in the API, browsers,
and workers.
