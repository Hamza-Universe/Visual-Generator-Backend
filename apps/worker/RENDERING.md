# Production rendering (Stages 3E–3F)

Two production paths coexist. The worker routes on the render row's
`specSnapshot` envelope — no queue/Redis redesign, no DB migration.

Two production paths coexist. The worker routes on the render row's
`specSnapshot` envelope — no queue/Redis redesign, no DB migration.

## New path (preferred for SceneDocument work)

```text
SceneDocument (editor)
  ↓  POST /scenes/:id/renders → immutable snapshot
renders.specSnapshot = { source: 'scene-document', document, definitions }
  ↓  BullMQ `render` job ({ renderId only })
worker: parseSceneRenderSnapshot() → collect assets → renderSceneDocument()
  ↓  SceneDocumentProduction composition
useCurrentFrame() → renderSceneAtFrame(document, frame) → buildRenderTree()
  ↓  registered renderers (Label, CounterPill, Hub, Arrow, LogoCard…)
renderMedia() → mp4 → storage → renders.status = done
```

- Timeline: `document.timeline` via the single `resolveTimeline()`
  interpretation (defaults 30fps / 300 frames). Never hard-coded.
- Animation authority: the shared Stage 3A evaluator only. The composition
  holds no interpolation, no per-frame DB reads, no editor state.
- Definitions: `componentDefinitionId → renderer name`, resolved once at
  enqueue time and frozen in the snapshot. Unknown instances render the
  existing "Unsupported component" fallback instead of crashing.
- Assets: collected from instance props via each definition's `assetProps`
  (existing mechanism), staged to the bundle public dir, passed as
  composition `assets`. Current built-in renderers ignore them, so behavior
  is unchanged and asset-backed components stay forward-compatible.
- Immutability: the snapshot is parsed into fresh objects; evaluation
  returns copies per frame. Rendering never mutates the stored document.

## Legacy path (compatibility)

```text
project.spec (VideoSpec)
  ↓  POST /projects/:id/renders
renders.specSnapshot = VideoSpec
  ↓  BullMQ `render` job
worker: VideoSpecSchema.parse → renderProject() → VisualDiagram → renderMedia()
```

Untouched. Delete nothing here until a deliberate decommission stage.

## Migration boundary

- Route: `POST /scenes/:id/renders` (new) vs `POST /projects/:id/renders` (legacy).
- Snapshot marker: `specSnapshot.source === 'scene-document'` (see
  `packages/schema/src/snapshot.ts`).
- Worker branch: `apps/worker/src/index.ts` (`isSceneDocumentSnapshot`).
- Entrypoints: `renderSceneDocument()` vs `renderProject()`
  (`apps/worker/src/renderer.ts`).
- Compositions: `SceneDocumentProduction` (new) vs `VisualDiagram`
  (legacy); `SceneDocumentPreview` remains a non-production preview target.

## Invoking a SceneDocument render

`POST /scenes/:id/renders` (authenticated, scene access required) → `202`
with the render row. Poll `GET /renders/:id`; fetch bytes from
`GET /renders/:id/file` once `status === 'done'`.

Required data (all frozen at enqueue): the full document (timeline,
components, groups) plus the definition map. The worker re-validates the
snapshot and resolves asset rows at job time — the renderer itself receives
one coherent, local input.

## Migration boundary (Stage 3G)

Canonical (current production path):

```text
SceneDocument → SceneRenderSnapshot → BullMQ → SceneDocumentProduction → Remotion
```

Legacy (deprecated, functional):

```text
VideoSpec → legacy render endpoint → legacy renderer → VisualDiagram → Remotion
```

### Every remaining VideoSpec reference (audited)

| Area | Reference | Role |
| ---- | --------- | ---- |
| `apps/worker/src/renderer.ts` | `renderProject()` | legacy entrypoint, targets `VisualDiagram` |
| `apps/worker/src/remotion/video.tsx` | `VideoComposition` + helpers | legacy composition (untouched) |
| `apps/worker/src/remotion/index.tsx` | `VisualDiagram` registration | legacy composition target |
| `apps/worker/src/index.ts` | `runLegacyRender()` branch | legacy job path (non-snapshot rows) |
| `apps/api/src/routes/renders.ts` | `POST /projects/:id/renders` | legacy endpoint (deprecated, 202 + `Deprecation: true`) |
| `apps/api/src/routes/projects.ts` | `project.spec` validation | project spec storage (VideoSpec content) |
| `apps/api/src/routes/generate.ts` + `services/ai/*` | generation/validation | AI pipeline produces VideoSpec (out of scope) |
| `packages/schema/src/spec.ts`, `validate.ts` | `VideoSpecSchema`, `validateSpec` | legacy model (kept) |
| Frontend `pages/EditorPage.tsx` + `useRenders` | project render queue UI | deliberate legacy surface for project-spec videos |
| MCP `create_render` | `POST /projects/:id/renders` | legacy production dependency (kept compatible) |
| MCP `validate_spec`/`submit_spec`/`generate_spec` | project specs | AI/spec pipeline (kept) |
| MCP `get_render`, `GET /renders/:id`, file/history endpoints | — | source-neutral, shared by both paths |

The scene canvas (`SceneEditorPage` → `SceneRenderPanel` → `POST
/scene/:id/renders`) uses SceneDocument rendering exclusively.

### Telemetry

Structured `{"telemetry":"render", event, source, renderId, projectId,
sceneId, timestamp}` lines (never payloads): API `request.log.info` on
`requested`; worker `console.info` on `succeeded`/`failed` (cancellations
excluded so failure rates stay honest). Builders/emitter:
`packages/schema/src/renderTelemetry.ts`.

### Deprecation signals

- `POST /projects/:id/renders` returns `Deprecation: true` + `Link:
  </scenes/{id}/renders>; rel="successor-version"`. Clients unaffected.
- OpenAPI marks it `deprecated: true`; the scene endpoint is documented as
  the current production path.

### VideoSpec removal readiness checklist

```text
VideoSpec removal is safe when:

[ ] no frontend production calls (BLOCKED: project EditorPage render queue)
[ ] no MCP production dependency (BLOCKED: create_render → legacy endpoint)
[ ] no active API consumers (verify via telemetry: zero video-spec events)
[ ] AI/generate pipeline migrated off VideoSpec (BLOCKED: out of scope)
[ ] project.spec storage migrated (BLOCKED: out of scope)
[ ] legacy tests isolated (OK: validate/snapshot-routing tests are independent)
[ ] telemetry shows zero/acceptable usage (pending observation window)
[ ] migration documentation exists (OK: this file + OpenAPI)
[ ] rollback path understood (OK: removal = code deletion only; rows already
    rendered keep working since snapshots are self-contained)
```

**Verdict: VideoSpec is NOT currently safe to remove.** Blockers are the
project-page render queue, the MCP `create_render` tool, and the
AI/generation pipeline that produces `VideoSpec` content. Nothing was
deleted in this stage; the legacy path renders exactly as before.

## Lifecycle (Stage 3F)

```text
POST /scenes/:id/renders → 202, record queued/progress 0 → BullMQ {renderId}
  (jobId = render id, so cancel can find it)
  ↓ worker picks up job
record cancelled while queued → job returns early, renders nothing
  ↓ otherwise
status = running, startedAt set
  ↓ snapshot parsed, assets resolved → progress 5 (bundle prepared)
renderMedia() progress p → 5 + p·0.9 (rendering, monotonic 5–95)
  ↓ output stored
status = done, progress 100, outputAssetId + completedAt set
```

- Statuses: `queued → running → done`, with `failed` and `cancelled` from
  `queued`/`running`. Terminal records never transition again.
  (`done` ≡ completed, `running` ≡ processing in task terminology; the
  stored vocabulary keeps the existing API/frontend/OpenAPI contract.)
- Failure: exception → `failed` + message + `completedAt`. Records never
  stick in `running`.
- Cancellation: `POST /renders/:id/cancel` marks the record `cancelled`
  (+ `completedAt`) and removes the queued BullMQ job when possible. An
  already-running encode cannot always be force-terminated, so the worker
  cooperatively observes cancellation (~1/sec progress checkpoints, never
  per frame) and aborts; a cancelled record is never later marked `done`
  or `failed`. Terminal renders reject cancel with 409.
- Duplicate protection: `POST /scenes/:id/renders` accepts an optional
  `clientKey`; a repeated key while a render for the scene is still
  non-terminal returns the existing row (202) instead of a duplicate.
  Without a key, every request is intentional.
- Retries: BullMQ `attempts: 1` (unchanged). A retry re-runs the whole job
  from the immutable snapshot; output assets are only created on success,
  so retries cannot corrupt the record.
- Polling: `GET /renders/:id/status` (lean, no snapshot payload) and
  `GET /scenes/:id/renders` (history, latest 20). Frontend polls every 2s
  while non-terminal and stops at terminal states.
