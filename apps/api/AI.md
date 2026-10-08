# Scene AI Architecture (Stage 4A + Stage 4B bounded agent)

> **AI is a planner, not the rendering engine.** The AI never generates React,
> Remotion, JSX, HTML, CSS, SVG, or any executable code. Its only output is a
> structured operation plan that deterministic application code validates and
> applies to the single canonical visual model: `SceneDocument`.

## Request flow

Single-shot planning (Stage 4A):

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

Bounded agent execution (Stage 4B) — one request, application-owned budgets:

```
POST /scenes/:id/ai/execute
    ↓
Authorization first (fetchSceneDocument → 403/404 before any model cost)
    ↓
┌─ iteration 1..maxIterations (default 3) ────────────────────────────┐
│  model turn: { toolCalls }  → allowlisted read tools over the        │
│                in-memory snapshot → bounded observations             │
│  or model turn: { plan + verification }                              │
│       ↓                                                              │
│  validateScenePlan (fresh document + request-scoped clientKeys)      │
│       ├─ invalid → feedback to the model, next iteration (no write)  │
│       ↓ valid                                                       │
│  applyScenePlan  (the SAME Stage 4A path — one write mechanism)      │
│       ↓                                                              │
│  verifySceneExpectations (deterministic: exists/position/size/        │
│       overlap/references, re-evaluated against the document)         │
│       ├─ passed → status 'completed', stop                           │
│       └─ failed → verification feedback, next iteration              │
└──────────────────────────────────────────────────────────────────────┘
    ↓
200 { status, iterations, toolCalls, plans, appliedOperations,
      verification, failure?, document, meta }
```

The existing deterministic pipeline is untouched:

```
SceneDocument → Timeline evaluator → Render tree → Renderers → Remotion → MP4
```

## Files

```
apps/api/src/ai/
  systemPrompt.ts   versioned prompts + AI_CONTEXT_VERSION,
                    AI_AGENT_CONTEXT_VERSION, SCENE_AGENT_SYSTEM_PROMPT_V1
  operations.ts     AISceneOperation / AIScenePlan Zod schemas (the contract)
  context.ts         selective, capped AI context builder
  registry.ts        component definitions from the real DB registry
  provider.ts        AISceneProvider interface + OpenRouterProvider
                    (optional AbortSignal for the agent time budget)
  planner.ts         intent → context → provider → validated plan
  apply.ts           pure plan validation + validate-then-apply orchestration
                    (+ request-scoped usedClientKeys idempotency)
  agent.ts           bounded loop: limits, turn schema, context overlay
  verification.ts    machine-checkable expectations + deterministic evaluator
  observability.ts   payload-free request metadata (plan/apply + agent)
  tools.ts           read-only tool harness, deterministic layout math,
                    and the bounded-agent tool allowlist/executor
apps/api/src/routes/ai.ts   POST /scenes/:id/ai/plan, POST /scenes/:id/ai/apply,
                          POST /scenes/:id/ai/execute
apps/api/scripts/ai-smoke.ts    optional live smoke (plan path)
apps/api/scripts/agent-smoke.ts optional live smoke (bounded agent)
```

## OpenRouter configuration

Environment variables (server-side only; never exposed to the frontend):

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | *(empty)* | Server-side key. When empty, plan requests fail fast with `AI_MODEL_UNAVAILABLE` (503). |
| `OPENROUTER_MODEL` | `openrouter/free` | Model id. Changing it requires **no** application-code changes. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Overridable for proxies/tests. |

Bounded-agent budgets (Stage 4B). These are **application-owned**: the
frontend and the model can never supply or raise them.

| Variable | Default | Bounds | Purpose |
| --- | --- | --- | --- |
| `AI_AGENT_MAX_ITERATIONS` | `3` | 1–5 | Hard cap on inspect → plan → apply → verify iterations per request. |
| `AI_AGENT_TOOL_BUDGET` | `16` | 0–64 | Total read-tool calls across the whole request. |
| `AI_AGENT_OPERATION_BUDGET` | `100` | 1–500 | Operations across all applied plans in the request (the 50-per-plan cap still applies). |
| `AI_AGENT_TIMEOUT_MS` | `60000` | 1000–300000 | Wall-clock budget for the whole agent request. |

Two more limits are fixed in code (`DEFAULT_AGENT_LIMITS`): 6 model turns
per iteration and 2 bounded retries for schema-invalid responses.

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

## Bounded agentic execution (Stage 4B)

`POST /scenes/:id/ai/execute` runs one bounded request. The model plans and
reasons; deterministic code stays the authority for application and for
deciding when the goal is met.

### Loop contract

Each iteration is: **inspect → decide → validate → apply → verify**.

- A *decision* is a Zod-validated turn
  (`AIAgentTurnSchema`): either `{ toolCalls }` (inspection only) or
  `{ plan, verification }` / `{ done, verification }`. `verification` is
  mandatory whenever a plan or `done` is sent — the model must state how
  success will be measured *before* it applies anything.
- Tool calls execute first against the current in-memory snapshot;
  bounded observations are fed back in the next context message.
- A plan goes through the exact Stage 4A path:
  `validateScenePlan` → `applyScenePlan` (which re-validates against a fresh
  document). **Invalid plans are never applied** — they become feedback for
  the next bounded iteration instead of a partial write.
- After a successful apply (or a `done`), `verifySceneExpectations`
  re-evaluates the model's expectations against the authoritative document:
  instance existence, position/size (1px tolerance), overlaps (listed,
  listed-vs-scene, required pairs), and reference validity. Passed →
  `completed`; failed → bounded correction.
- The loop is request-scoped: no agent state is persisted, no background
  job, no memory across requests.

### Statuses (application-decided, returned with 200)

| Status | Meaning |
| --- | --- |
| `completed` | Verification passed; nothing further to do. |
| `max_iterations` | Iteration budget spent; last verification still failing. |
| `validation_failed` | Plans (or model responses) kept failing validation; feedback budget exhausted. |
| `tool_error` | Tool/turn budget exhausted or too many failed tool calls. |
| `provider_error` | Provider/network failure — stopped immediately, never blind-retried. |
| `application_error` | A validated plan failed at runtime mid-apply — stopped; the write is never repeated after an ambiguous failure. |
| `unauthorized` | Authorization failed (pre-loop → 403/404; at apply time → status here). |
| `timeout` | Wall-clock budget exceeded — checked before every model call. |

Every non-completed response still includes the **current document** and the
list of operations applied so far, so clients refresh correctly after a
partial application.

### Why there is no infinite loop

The loop cannot be extended from inside: `maxIterations` is clamped
server-side (1–5), turns/iteration and tool calls per turn are capped, the
tool budget and operation budget are decremented by the harness (the model
cannot raise them), the deadline is absolute, and every failure mode maps to
a terminal status. There is no autonomous goal generation — the loop runs
only against the user's single prompt.

### Idempotency

A request-scoped `clientKey → id` map is threaded through
`validateScenePlan`/`applyScenePlan`: once a create operation has been
applied, re-using its `clientKey` in a later iteration is rejected with
feedback ("already created in this request (id …); address it by id"), so
bounded corrections can never duplicate an object. The Stage 4A `clientKey`
render-idempotency semantics are unchanged.

### Read tools

The agent may call exactly these five tools (explicit allowlist in
`tools.ts`, each with a Zod-validated argument schema and size-capped
results with explicit truncation flags):

```
getScene           findInstances        getInstance
getInstanceBounds  findOverlaps
```

There is no write tool, no filesystem/shell/SQL/HTTP/JS tool, and unknown
tool names are rejected as observations rather than executed.

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

Stage 4B adds `AI_AGENT_CONTEXT_VERSION = "1"` and
`SCENE_AGENT_SYSTEM_PROMPT_V1` for the bounded agent. The agent reuses the
unchanged Stage 4A scene context pack (its version stays `"1"`) and adds an
agent overlay: iteration/turn counters, remaining budgets, tool specs,
observations from this iteration, `createdThisRequest` (clientKey → real id),
prior-iteration summaries, and the last validation/verification/schema
feedback. Like the scene pack it is capped (8 observations, 10 feedback
issues per message).

## Observability

Each plan/apply/execute request logs payload-free metadata: request id, scene
id, provider, model, context version, timestamp, latency, success/failure,
and token usage when OpenRouter returns it. Agent requests additionally log
iterations, tool calls, model calls, applied operation count, and the
termination status. Full prompts and responses are never logged or stored. No
AI history table exists (and none is planned).

## Security boundary

The AI is an **untrusted planner**; the application is the authority.

- No code execution of any kind: no JavaScript, shell, filesystem, SQL, or
  arbitrary HTTP from the model's output.
- Scene authorization, component authorization, and reference validation all
  run in deterministic code around/inside the existing domain layer. The
  execute endpoint performs authorization **before** the first model call,
  and re-checks it inside the apply path on every iteration.
- Budgets and the tool allowlist are server-side; the model cannot expand
  its own capabilities, and the client cannot set limits.
- The API key exists only in server environment configuration.
- The plan/apply/execute endpoints are authenticated and scope every
  operation to scenes the caller owns.
- MCP exposes the same endpoints as thin proxies; validation, budgets, and
  authorization stay in the API.

## Tool harness

`tools.ts` holds the harness: pure read tools (`getSceneSummary`,
`findInstances`, `getInstance`, `getInstanceBounds`, `findOverlaps`,
`findSceneOverlaps`) and deterministic layout math (`alignInstances`,
`distributeInstances`) over an in-memory snapshot. Read tools inspect; write
intent always flows through validated operation plans.

Stage 4B layers an explicit registry on top: `AGENT_TOOL_SPECS` is the
allowlist, `executeAgentTool` validates arguments with Zod, bounds every
result (20 items / 40 overlap pairs / 4000 serialized chars) with an
explicit `truncated` flag, and returns structured errors for unknown tools
or bad arguments — which the harness feeds back to the model as
observations instead of crashing. Tools receive only the document snapshot:
no database handle, no network, no state mutation.

## Frontend

`src/components/ai/AiPanel.tsx`: prompt input → **Generate plan** → plan
preview (operation list, review before mutation) → **Apply plan** → the
updated document lands in the editor store. Stage 4B adds **Execute**, which
calls `POST /scenes/:id/ai/execute` and shows one bounded result card:
termination status, iterations, tool calls, applied-operation count, and the
verification issues (or "verified"). The document returned by execute is
always refreshed, including for non-completed statuses. No chat history,
streaming, model selector, or token dashboard.

## Testing

`apps/api/test/ai.test.ts` (provider, context, validation, planning,
application, OpenAPI contract), `apps/api/test/agent.test.ts` (bounded loop,
read tools, safety, idempotency, termination), and
`apps/mcp/test/tools.test.ts` cover the harness with a **mocked provider**.
Agent tests run the real turn schema, tools, validation, apply, and
verification against an in-memory mutable document — including the key
scenarios: one-shot success, an insufficient move corrected in a second
iteration after deterministic overlap verification, and clean termination at
the iteration limit. No automated test requires an OpenRouter key or burns
free-tier requests.

## Optional live smoke tests

With `OPENROUTER_API_KEY` set locally:

```bash
pnpm --filter @app/api exec tsx scripts/ai-smoke.ts    # single-shot plan
pnpm --filter @app/api exec tsx scripts/agent-smoke.ts # bounded agent (seeds a temporary scene)
```

Each sends a small number of real requests and prints the outcome. Both exit
with code 2 when no key is configured. The automated suite never invokes
them.

## Future work (not in this stage)

- Primary/fallback model routing (config already carries the model)
- Applying plans transactionally once the domain layer supports it
- Richer animation operations (the schema/evaluator path is already shared)
- Stage 4C candidates: deterministic layout assistance for the agent,
  narration/voice-over over the existing timeline, prompt library,
  richer verification signals (style/contrast invariants)
