# Scene AI Architecture (Stage 4A)

> **AI is a planner, not the rendering engine.** The AI never generates React,
> Remotion, JSX, HTML, CSS, SVG, or any executable code. Its only output is a
> structured operation plan that deterministic application code validates and
> applies to the single canonical visual model: `SceneDocument`.

## Request flow

```
User Intent
    ↓
POST /scenes/:id/ai/plan        (planning only — never mutates)
    ↓
Context builder (selective, versioned)
    ↓
AIProvider (OpenRouter today, abstraction underneath)
    ↓
unknown JSON
    ↓
Zod validation (AIScenePlanSchema)
    ↓
AI plan (temporary intent, reviewed by the user)
    ↓
POST /scenes/:id/ai/apply
    ↓
Full-plan validation against a fresh SceneDocument snapshot
    ↓
Existing domain mutations (services/documents.ts)
    ↓
SceneDocument
    ↓
Existing Editor / Preview / Renderer   (unchanged)
```

The existing deterministic pipeline is untouched:

```
SceneDocument → Timeline evaluator → Render tree → Renderers → Remotion → MP4
```

## Files

```
apps/api/src/ai/
  systemPrompt.ts   versioned system prompt + AI_CONTEXT_VERSION
  operations.ts     AISceneOperation / AIScenePlan Zod schemas (the contract)
  context.ts         selective, capped AI context builder
  registry.ts        component definitions from the real DB registry
  provider.ts        AISceneProvider interface + OpenRouterProvider
  planner.ts         intent → context → provider → validated plan
  apply.ts           pure plan validation + validate-then-apply orchestration
  observability.ts   payload-free request metadata (id, model, latency, usage)
  tools.ts           read-only tool harness + deterministic layout math
apps/api/src/routes/ai.ts   POST /scenes/:id/ai/plan, POST /scenes/:id/ai/apply
apps/api/scripts/ai-smoke.ts  optional live smoke test (manual, key required)
```

## OpenRouter configuration

Environment variables (server-side only; never exposed to the frontend):

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | *(empty)* | Server-side key. When empty, plan requests fail fast with `AI_MODEL_UNAVAILABLE` (503). |
| `OPENROUTER_MODEL` | `openrouter/free` | Model id. Changing it requires **no** application-code changes. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Overridable for proxies/tests. |

The application code depends on the internal `AISceneProvider` interface, not
on OpenRouter. `resolveAIModelConfig()` centralizes model selection so future
providers (and fallback chains) plug in without touching call sites.

## Structured output

The provider sends system + user messages with
`response_format: { type: 'json_object' }`, strips markdown fences, parses
JSON, and validates against the requested Zod schema **before** returning.
Failures are mapped to AI-specific errors that follow the existing API error
convention (`AppError`):

| Code | HTTP | Meaning |
| --- | --- | --- |
| `AI_MODEL_UNAVAILABLE` | 503 | No API key / no model configured |
| `AI_PROVIDER_ERROR` | 502 | Provider HTTP or network failure |
| `AI_INVALID_RESPONSE` | 502 | Unreadable or empty model content |
| `AI_SCHEMA_ERROR` | 502/422 | Response or plan does not match the schema |
| `AI_OPERATION_INVALID` | 422 | Plan fails domain validation (applies nothing) |

API keys never appear in error messages, logs, or telemetry.

## AI plan and operations

`AIScenePlan = { operations: AISceneOperation[] }` (max 50 operations).
Supported operation types:

```
createInstance   updateInstance   deleteInstance
createGroup      deleteGroup
moveInstance     resizeInstance
updateProps      updateStyle
setVisibility    setZIndex        setReference
addAnimationTrack  addKeyframe    deleteKeyframe
```

Addressing rules:

- New instances/groups are referenced inside the plan by the `clientKey` the
  model assigns in their create operation; the plan is applied in order and
  keys resolve to the ids the domain layer returns.
- Existing objects are referenced by real instance/group UUIDs from the
  context — the model never invents ids.
- `createInstance` names a component by **definition name** from the supplied
  registry; ids stay server-side.

This is temporary intent, not a second document model: there is no `AIScene`,
`AIProject`, or `AIAnimation`. `SceneDocument` remains the only canonical
model.

## Validation and application semantics

1. **Plan endpoint never mutates.** It only builds context, calls the
   provider, and validates the response.
2. **Apply validates the complete plan first** against a fresh
   `SceneDocument` snapshot (`validateScenePlan`): unknown definitions,
   missing instances, bad references, out-of-range keyframes, duplicate
   `clientKey`s, forward references, and props that violate the component
   JSON schema are all rejected with `422 AI_OPERATION_INVALID` and a list of
   issues — **zero database writes**.
3. **Valid plans apply sequentially through the existing domain mutations**
   in `services/documents.ts` (`createInstance`, `updateInstance`,
   `deleteInstance`, `createGroup`, `deleteGroup`). There is no second
   mutation system; component authorization (`requireSceneAccess`,
   `requireAccessibleDefinition`) and reference validation
   (`assertValidInstanceReferences`, `resolveInstanceProps`) stay
   authoritative because they run inside those functions.

**Documented limitation:** application is validation-first but not wrapped in
a single database transaction. An invalid plan can never partially apply; a
mid-apply *runtime* failure (e.g. database outage between operations) is the
residual risk. Introducing a transaction wrapper is a follow-up once the
domain mutations participate cleanly in one.

## Context construction

The context builder is selective and capped — never the repository, never
another user's data:

- scene metadata (name, fps, durationFrames, counts, truncation flags)
- current instances (id, definition name, label, position, size, visibility,
  z-index, group, animation tracks, selection) — capped at 80
- groups (id, name, parent)
- authorized component definitions with compact prop schemas and `refProps`
  — capped at 40
- operation instructions (types, addressing rules, easing names)

Component definitions come from the real database registry
(`listDefinitionsForAI`); nothing is duplicated by hand. Authorization
filtering reuses `isComponentVisibleToUser` — private definitions of other
users are never included, and `createInstance` in a plan is only accepted for
definitions in the caller's authorized set.

## System prompt and context versioning

`AI_CONTEXT_VERSION = "1"` in `systemPrompt.ts` labels both the system prompt
and every context pack. Bump it when prompt/context semantics change so
historical requests remain explainable. The prompt is deliberately small:
planner rules only — no repository architecture dump.

## Observability

Each plan/apply request logs payload-free metadata: request id, scene id,
provider, model, context version, timestamp, latency, success/failure, and
token usage when OpenRouter returns it. Full prompts and responses are never
logged or stored. No AI history table exists (and none is planned).

## Security boundary

The AI is an **untrusted planner**; the application is the authority.

- No code execution of any kind: no JavaScript, shell, filesystem, SQL, or
  arbitrary HTTP from the model's output.
- Scene authorization, component authorization, and reference validation all
  run in deterministic code around/inside the existing domain layer.
- The API key exists only in server environment configuration.
- The plan/apply endpoints are authenticated and scope every operation to
  scenes the caller owns.
- MCP exposes the same two endpoints as thin proxies; validation stays in
  the API.

## Tool harness

`tools.ts` holds the initial harness: pure read tools (`getSceneSummary`,
`findInstances`, `getInstanceBounds`, `findOverlaps`) and deterministic
layout math (`alignInstances`, `distributeInstances`) over an in-memory
snapshot. Read tools inspect; write intent always flows through validated
operation plans. This is the seed for a future tool-registry loop — there is
deliberately **no** autonomous agent loop, retry loop, or memory today.

## Frontend

`src/components/ai/AiPanel.tsx`: prompt input → **Generate plan** → plan
preview (operation list, review before mutation) → **Apply plan** → the
updated document lands in the editor store. Nothing else: no chat history,
streaming, model selector, or token dashboard.

## Testing

`apps/api/test/ai.test.ts` (provider, context, validation, planning,
application, OpenAPI contract) and
`apps/mcp/test/tools.test.ts` cover the harness with a **mocked provider**.
No automated test requires an OpenRouter key or burns free-tier requests.

## Optional live smoke test

With `OPENROUTER_API_KEY` set locally:

```bash
pnpm --filter @app/api exec tsx scripts/ai-smoke.ts
```

Sends exactly one request, validates the returned plan against the fixture
document, and prints it. Exits with code 2 when no key is configured. The
automated suite never invokes it.

## Future work (not in this stage)

- Primary/fallback model routing (config already carries the model)
- Write tools + agentic iteration with bounded loops
- Applying plans transactionally once the domain layer supports it
- Richer animation operations (the schema/evaluator path is already shared)
