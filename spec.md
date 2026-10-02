# Backend Build Spec: AI Explainer Animation Tool

This file is the single source of truth. Read all of it before writing code.

## 0. How to work with this file

1. Work phase by phase (see section 14). Do not start a phase until the previous phase passes its checks.
2. Do exactly what is written. Do not add features, endpoints, tables, or packages that are not listed.
3. If something is unclear or missing, ask a question. Do not guess or invent.
4. Do not pin package versions from memory. Install the latest stable version at install time, then keep the lockfile.
5. After each phase, show: files created, commands to run, and the result of the checks.

## 1. What we are building

A personal tool. The user uploads an audio or video file of themselves explaining something. The backend:

1. Turns the speech into text with a timestamp for every word (transcript).
2. Sends the transcript and a list of available animation components to an AI. The AI returns a small JSON file (the "spec") that says which component appears, when, and how.
3. Stores the spec. The user can read and edit it (CRUD).
4. Queues a render job. A worker turns the spec into an MP4 video.

The AI never writes code. It only writes the JSON spec, using components that already exist in the component registry.

The frontend (React + Remotion Player) and the real Remotion components are built later, in separate work. This spec covers the backend only.

## 2. Hard rules

- Language: TypeScript everywhere, `strict: true`, ESM modules. No `any`. Use `unknown` and narrow it.
- Every request body, query, and param is validated with Zod inside the handler. Do not use Fastify type-provider libraries.
- One error format for all failures:
  `{ "error": { "code": "STRING_CODE", "message": "human readable", "details": [] } }`
- Use these HTTP codes: 200, 201, 202, 204, 400 (bad input shape), 404, 409, 422 (spec is valid JSON shape but breaks a semantic rule), 500.
- No authentication for now (single user). Do not add login code.
- Log with Fastify's built-in pino logger. Never log API keys.
- Read all configuration from environment variables through one file: `apps/api/src/config.ts` (and the same pattern in the worker). Validate env with Zod at startup and exit with a clear message if something is missing.
- Keep files small and focused. No file over 300 lines.
- No comments that only repeat the code. Comments only for "why".
- Do not use LangChain, an ORM other than Drizzle, or Express.

## 3. Tech stack (exact)

- Runtime: Node.js (current LTS), TypeScript, pnpm workspaces
- API: Fastify, `@fastify/cors`, `@fastify/multipart`
- Validation: Zod (version 4). For JSON Schema output use Zod's built-in `z.toJSONSchema`. If it is not available in the installed version, use `zod-to-json-schema`.
- Component props validation: `ajv` and `ajv-formats` (component props schemas are stored in the database as JSON Schema)
- Database: PostgreSQL, Drizzle ORM (`drizzle-orm`, `drizzle-kit`), driver `postgres` (postgres.js)
- Queue: Redis and BullMQ
- AI: `@google/genai` for Gemini generation and transcription, hidden behind an interface (see section 10)
- Tests: Vitest
- Lint and format: ESLint and Prettier with default recommended TypeScript settings
- Local services: Docker Compose (Postgres and Redis only). API and worker run on the host with pnpm.

## 4. Repository layout

```
/
  package.json                 (root scripts, workspaces)
  pnpm-workspace.yaml
  tsconfig.base.json
  docker-compose.yml
  .env.example
  BACKEND_SPEC.md
  packages/
    schema/                    (Zod schemas, types, validateSpec, defaultSpec)
      src/
        spec.ts
        validate.ts
        registry.ts
        index.ts
      test/
    db/                        (Drizzle schema, migrations, client, seed)
      src/
        schema.ts
        client.ts
        seed.ts
      drizzle/                 (generated migrations)
  apps/
    api/
      src/
        index.ts
        config.ts
        errors.ts
        routes/
          health.ts
          projects.ts
          components.ts
          assets.ts
          transcripts.ts
          generate.ts
          renders.ts
        services/
          storage.ts           (StorageProvider interface + LocalStorage)
          transcription.ts     (TranscriptionProvider interface + Gemini media transcription)
          generator.ts         (AI spec generation)
          queue.ts             (BullMQ queue producer)
      test/
    worker/
      src/
        index.ts
        config.ts
        renderer.ts            (stub for now)
```

Package names: `@app/schema`, `@app/db`, `@app/api`, `@app/worker`. Apps import the packages through the workspace.

## 5. Environment variables

`.env.example` must contain exactly these:

```
PORT=3001
DATABASE_URL=postgres://app:app@localhost:5432/explainer
REDIS_URL=redis://localhost:6379
STORAGE_DIR=./storage
GEMINI_API_KEY=
AI_PROVIDER=manual
AI_MODEL=gemini-2.0-flash
CORS_ORIGIN=http://localhost:5173
MAX_UPLOAD_MB=500
```

`GEMINI_API_KEY` and `AI_MODEL` are required only by direct Gemini routes. The API must still start without them, and those routes return 500 with code `MISSING_CONFIG` if they are empty. Manual mode needs no key.

## 6. Data model (Drizzle, PostgreSQL)

Use UUID primary keys (`gen_random_uuid()`), and `created_at` / `updated_at` timestamps with time zone (default now).

Table `projects`

- id, name (text, not null), spec (jsonb, not null), created_at, updated_at

Table `components` (the registry)

- id
- name (text, unique, not null, PascalCase, e.g. `LogoCard`)
- display_name (text, not null)
- description (text, not null; the AI reads this, so it must say what the component is for)
- props_schema (jsonb, not null; a JSON Schema object)
- default_props (jsonb, not null, default `{}`)
- enter_styles (text[], not null)
- exit_styles (text[], not null, default empty)
- color_props (text[], not null, default empty; names of props that hold a color)
- ref_props (text[], not null, default empty; names of props that hold another scene id)
- asset_props (text[], not null, default empty; names of props that hold an asset id)
- created_at, updated_at

Table `assets`

- id, kind (text: `audio`, `video`, `image`, `logo`), original_name (text), storage_key (text, not null), mime_type (text), size_bytes (bigint), duration_seconds (real, nullable), created_at

Table `transcripts`

- id, asset_id (uuid, references assets, on delete cascade), language (text, nullable), text (text, not null), words (jsonb, not null; array of `{ "word": string, "start": number, "end": number }` in seconds), duration_seconds (real, nullable), created_at

Table `renders`

- id, project_id (uuid, references projects, on delete cascade), status (text: `queued`, `running`, `done`, `failed`), progress (integer 0 to 100, default 0), spec_snapshot (jsonb, not null), output_asset_id (uuid, nullable, references assets), error (text, nullable), created_at, updated_at

Add an index on `renders.project_id` and on `transcripts.asset_id`.

## 7. The spec schema (packages/schema/src/spec.ts)

Implement exactly this. Export every schema and the inferred types (`VideoSpec`, `Scene`, `Theme`, and so on).

```ts
import { z } from 'zod';

export const EasingSchema = z.enum([
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'spring',
]);

export const AnchorSchema = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);

// A color is a hex value or a reference to a theme palette entry.
export const COLOR_PATTERN =
  '^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|palette:[a-zA-Z0-9_-]+)$';
export const ColorSchema = z.string().regex(new RegExp(COLOR_PATTERN));

export const TransitionSchema = z.object({
  style: z.string().min(1), // must exist in the component's enterStyles / exitStyles
  duration: z.number().min(0).max(10).default(0.5), // seconds, before the global speed is applied
  easing: EasingSchema.default('ease-out'),
});

export const BackgroundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('color'), color: ColorSchema }),
  z.object({
    type: z.literal('gradient'),
    from: ColorSchema,
    to: ColorSchema,
    angle: z.number().min(0).max(360).default(180),
  }),
  z.object({
    type: z.literal('image'),
    assetId: z.string().uuid(),
    fit: z.enum(['cover', 'contain']).default('cover'),
  }),
]);

export const ThemeSchema = z.object({
  background: BackgroundSchema,
  palette: z.record(
    z.string().regex(/^[a-zA-Z0-9_-]+$/),
    z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ),
  fontFamily: z.string().min(1).default('Inter'),
  // Global pace. Effective transition duration = transition.duration / speed.
  speed: z.number().min(0.25).max(4).default(1),
  defaultEasing: EasingSchema.default('ease-out'),
});

export const PositionSchema = z.object({
  anchor: AnchorSchema.default('center'),
  offsetX: z.number().min(-50).max(50).default(0), // percent of frame width
  offsetY: z.number().min(-50).max(50).default(0), // percent of frame height
});

export const SceneSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
    .max(64),
  component: z.string().min(1), // name in the component registry
  at: z.number().min(0), // start time in seconds (source of truth)
  duration: z.number().positive(), // seconds the scene stays on screen
  position: PositionSchema.default({
    anchor: 'center',
    offsetX: 0,
    offsetY: 0,
  }),
  props: z.record(z.string(), z.unknown()).default({}),
  color: ColorSchema.optional(), // main color override for this scene
  enter: TransitionSchema,
  exit: TransitionSchema.optional(),
  // Optional note: which spoken word `at` was taken from. For UI only. `at` is what counts.
  trigger: z
    .object({
      word: z.string().min(1),
      occurrence: z.number().int().min(1).default(1),
    })
    .optional(),
});

export const MetaSchema = z.object({
  fps: z.number().int().min(10).max(60).default(30),
  width: z.number().int().min(320).max(3840).default(1920),
  height: z.number().int().min(240).max(2160).default(1080),
  durationInSeconds: z.number().positive().max(3600),
});

export const VideoSpecSchema = z.object({
  version: z.literal(1),
  meta: MetaSchema,
  theme: ThemeSchema,
  audioAssetId: z.string().uuid().optional(),
  scenes: z.array(SceneSchema).max(300),
});
```

Also export `defaultSpec()` which returns a valid empty spec:

- `meta`: fps 30, 1920 x 1080, durationInSeconds 10
- `theme.background`: `{ type: "color", color: "#EFE9DC" }`
- `theme.palette`: `primary #F5A623`, `text #2B2620`, `surface #FFFFFF`, `accent #1F3A93`
- `scenes`: `[]`

### Example of a valid spec

```json
{
  "version": 1,
  "meta": { "fps": 30, "width": 1920, "height": 1080, "durationInSeconds": 12 },
  "theme": {
    "background": { "type": "color", "color": "#EFE9DC" },
    "palette": {
      "primary": "#F5A623",
      "text": "#2B2620",
      "surface": "#FFFFFF"
    },
    "fontFamily": "Inter",
    "speed": 1,
    "defaultEasing": "ease-out"
  },
  "scenes": [
    {
      "id": "hub",
      "component": "Hub",
      "at": 0.5,
      "duration": 11,
      "position": { "anchor": "top-center", "offsetX": 0, "offsetY": 5 },
      "props": { "label": "Stargate", "pulse": true },
      "color": "palette:primary",
      "enter": { "style": "pop", "duration": 0.6, "easing": "spring" }
    },
    {
      "id": "openai",
      "component": "LogoCard",
      "at": 2.1,
      "duration": 9,
      "position": { "anchor": "bottom-left" },
      "props": { "label": "OpenAI" },
      "enter": { "style": "pop", "duration": 0.4, "easing": "spring" },
      "trigger": { "word": "OpenAI", "occurrence": 1 }
    },
    {
      "id": "hub-to-openai",
      "component": "Arrow",
      "at": 2.6,
      "duration": 8.5,
      "props": { "from": "hub", "to": "openai", "style": "dashed" },
      "color": "palette:text",
      "enter": { "style": "draw", "duration": 0.8, "easing": "ease-in-out" }
    }
  ]
}
```

## 8. Semantic validation (packages/schema/src/validate.ts)

Export `validateSpec(spec: VideoSpec, ctx: ValidationContext): Issue[]`.

```ts
type Issue = { path: string; code: string; message: string };
type ValidationContext = {
  registry: Map<string, RegistryComponent>; // by component name
  assetExists: (id: string) => boolean; // ctx is built by the caller from the database
  assetKind: (id: string) => string | undefined;
};
```

The function is pure. It does not touch the database. The caller loads what it needs and passes it in. It returns all issues, not only the first. Rules:

1. `DUPLICATE_SCENE_ID`: scene ids must be unique.
2. `UNKNOWN_COMPONENT`: `scene.component` must exist in the registry.
3. `INVALID_PROPS`: validate `{ ...component.defaultProps, ...scene.props }` against `component.propsSchema` using Ajv (with `ajv-formats`, `allErrors: true`). One issue per Ajv error, path like `scenes[2].props.label`.
4. `UNKNOWN_ENTER_STYLE` / `UNKNOWN_EXIT_STYLE`: `enter.style` must be in `enterStyles`; `exit.style` must be in `exitStyles`. If a component has no exit styles, then `exit` must not be set.
5. `SCENE_OUT_OF_RANGE`: `at + duration <= meta.durationInSeconds + 0.001`.
6. `TRANSITIONS_TOO_LONG`: `(enter.duration + (exit?.duration ?? 0)) / theme.speed <= scene.duration`.
7. `UNKNOWN_PALETTE_COLOR`: every `palette:name` reference must exist in `theme.palette`. Check: `scene.color`, the background fields, and every prop named in the component's `colorProps`.
8. `BAD_REFERENCE`: every prop named in the component's `refProps` must be the id of another scene in the same spec, and not the scene's own id.
9. `UNKNOWN_ASSET`: `audioAssetId`, a background image `assetId`, and every prop named in `assetProps` must exist in the assets table (use `ctx.assetExists`). `audioAssetId` must have kind `audio` or `video`.

Write unit tests for every rule (one passing case and one failing case each).

## 9. API endpoints

Base path has no prefix. All bodies are JSON unless noted.

Health

- `GET /health` returns `200 { "ok": true }`. Also checks that the database answers a `select 1`.

Projects

- `POST /projects` body `{ name: string, spec?: VideoSpec }`. If `spec` is missing, use `defaultSpec()`. Validate shape (Zod) and semantics (`validateSpec`). Returns 201 with the project.
- `GET /projects` returns `{ items: [{ id, name, created_at, updated_at }] }` newest first. No spec in the list.
- `GET /projects/:id` returns the full project. 404 if missing.
- `PUT /projects/:id` body `{ name?: string, spec?: VideoSpec }`. Replaces what is sent. Validates the same way as create. 422 with `details` = the issues if semantic validation fails. Sets `updated_at`.
- `DELETE /projects/:id` returns 204.
- `POST /projects/:id/validate` body `{ spec: VideoSpec }`. Returns `200 { "valid": boolean, "issues": Issue[] }` without saving. The frontend uses this while the user types in the JSON editor.

Components (registry CRUD)

- `GET /components` returns `{ items: Component[] }`.
- `GET /components/:id`
- `POST /components` body: name, displayName, description, propsSchema, defaultProps, enterStyles, exitStyles, colorProps, refProps, assetProps. Check that `propsSchema` compiles with Ajv (else 400 `INVALID_PROPS_SCHEMA`). Check that `defaultProps` is valid against `propsSchema`. Name must be unique (409 `NAME_TAKEN`). Every name in `colorProps`, `refProps`, `assetProps` must be a property in `propsSchema.properties`.
- `PUT /components/:id` same checks.
- `DELETE /components/:id`: 409 `IN_USE` if any project spec uses this component name (search project specs in code, not with a complex SQL query).

Assets

- `POST /assets` multipart form with a `file` field and a `kind` field (`audio`, `video`, `image`, `logo`). Save the file through `StorageProvider`. Reject files larger than `MAX_UPLOAD_MB` (413). Returns 201 with the asset row.
- `GET /assets?kind=` list.
- `GET /assets/:id/file` streams the file with the right content type.
- `DELETE /assets/:id`: removes the row and the stored file. 409 `IN_USE` if a project spec references the asset.

Transcripts

- `POST /assets/:id/transcribe` body `{ language?: string }`. Asset kind must be `audio` or `video`. Calls `TranscriptionProvider`, saves the transcript, returns 201. This can take a while; keep it a normal request for now (no queue).
- `GET /transcripts/:id`
- `GET /assets/:id/transcripts` list for an asset.

Generate

- `POST /projects/:id/generate` body `{ transcriptId: string, instructions?: string, save?: boolean }` (`save` defaults to true). See section 10. Returns `200 { spec, issues: [], attempts }`. On failure after retry: `422` with the issues, and nothing is saved.

Renders

- `POST /projects/:id/renders` validates the current spec (422 if invalid). Copies the spec into `spec_snapshot`, inserts a `renders` row with status `queued`, adds a BullMQ job, returns `202` with the render row.
- `GET /renders/:id`
- `GET /projects/:id/renders` list, newest first.
- `GET /renders/:id/file` streams the output video if status is `done`, else 409 `NOT_READY`.

## 10. AI generation (apps/api/src/services/generator.ts)

Input: project id, transcript, optional user instructions.

Steps:

1. Load all components from the registry.
2. Build the catalog text: for each component, print name, description, props schema (compact JSON), default props, enter styles, exit styles, and which props are refs (scene ids), colors, or assets.
3. Build the transcript text as a list of words with start times, grouped in lines of about 12 words, each line prefixed with the start time of its first word, for example `[2.10] OpenAI SoftBank Oracle and MGX are ...`. Also give the total audio duration.
4. Call the Gemini API (`models.generateContent`) with:
   - the model from `ANTHROPIC_MODEL`
   - the system prompt below
   - one tool named `submit_spec` whose `input_schema` is the JSON Schema of `VideoSpecSchema` (generated from Zod)
   - `tool_choice: { type: "tool", name: "submit_spec" }`
5. Take the tool input. Parse with `VideoSpecSchema`, then run `validateSpec`.
6. If there are issues, do one retry: send the previous output and the issue list back and ask for a corrected spec. Maximum 2 attempts in total.
7. If `save` is true and the spec is valid, update the project. Also copy the transcript's `audio_asset_id` (the asset the transcript came from) into `spec.audioAssetId` if that asset is audio or video.
8. The theme: if the project already has a theme, keep it and tell the AI not to change it (pass the current theme in the prompt, and after generation overwrite `spec.theme` and `spec.meta.fps/width/height` with the project's existing values). The AI decides only `scenes` and `meta.durationInSeconds`.

### System prompt (use this text exactly, in a constant)

```
You turn a spoken transcript into a JSON animation spec for an explainer video.
You do not write code. You only call the tool submit_spec.

Rules:
1. Use only components from the catalog. Never invent a component name.
2. Every scene needs a unique id made of letters, numbers, dash or underscore. Start with a letter.
3. Times are in seconds. Set "at" from the start time of the spoken word that the visual is about. A visual may appear up to 0.3 seconds before the word, never after it. Add a "trigger" with that word.
4. Keep every scene inside the video: at + duration must not be more than meta.durationInSeconds. Set meta.durationInSeconds to the audio duration.
5. Use positions from the anchor list. Use offsetX and offsetY (percent) only for small adjustments. Do not place scenes on top of each other unless one is meant to sit on another.
6. For components that connect things, use the ids of scenes that exist in your output.
7. Use only enter and exit styles listed for that component.
8. Colors: use "palette:name" with names from the theme palette. Use a hex color only when the user asks for it.
9. Prefer few, clear visuals. Do not add a visual for every sentence. One idea, one visual.
10. Do not change the theme.
```

### User message layout

1. Component catalog
2. Current theme (JSON)
3. Transcript with timestamps and total duration
4. The user's extra instructions, if any
5. One line: "Call submit_spec now."

## 11. Transcription (apps/api/src/services/transcription.ts)

```ts
export interface TranscriptionProvider {
  transcribe(input: { filePath: string; language?: string }): Promise<{
    text: string;
    language?: string;
    durationSeconds?: number;
    words: { word: string; start: number; end: number }[];
  }>;
}
```

Implement `GeminiTranscriptionProvider`: upload audio or extracted video audio to Gemini and request JSON containing the transcript, language, duration, and word-level timestamps. Map the result to the shape above.

If the uploaded file is larger than the provider limit or is a video, extract the audio first with `ffmpeg` (a command-line call with `child_process`, output mono 16 kHz mp3). Add a startup check that logs a warning if `ffmpeg` is not installed. Do not add an ffmpeg npm wrapper.

The provider remains behind `TranscriptionProvider` so it can later be replaced by a local implementation without changing routes.

## 12. Queue and worker

Queue name: `render`. Job data: `{ renderId: string }`. Job options: 1 attempt, remove on complete after 100 jobs, remove on fail after 100 jobs.

`apps/api/src/services/queue.ts` only adds jobs. `apps/worker` consumes them.

Worker steps for each job:

1. Load the render row. Set status `running`, progress 0.
2. Call `renderProject({ spec, audioPath, outputPath, onProgress })` from `renderer.ts`.
3. On progress, update `renders.progress` (not more often than once per second).
4. On success: save the output file through `StorageProvider`, create an `assets` row (kind `video`), set `output_asset_id`, status `done`, progress 100.
5. On error: status `failed`, save the error message.

`renderer.ts` is a STUB in this phase. It must:

- take about 5 seconds, call `onProgress` from 0 to 100 in steps,
- write a small placeholder file to `outputPath` (plain text saying "placeholder render"),
- have a clear `TODO` comment that the real Remotion renderer replaces this function later, with the same function signature.

Do not install or import Remotion in this phase.

The worker gets its own `config.ts` (DATABASE_URL, REDIS_URL, STORAGE_DIR). Share DB access through `@app/db`. Share `StorageProvider` by putting it in a small shared place (either `packages/db` or a new `packages/storage`; choose one and say which).

## 13. Seed components (packages/db/src/seed.ts)

`pnpm db:seed` inserts these five components if they do not already exist (match by name). It must be safe to run many times.

Common color pattern for props: use `COLOR_PATTERN` from `@app/schema` as the `pattern` value.

1. `Hub`: a circle in the center that other items connect to. Optional pulse ring.
   - props: `label` (string, max 40, optional), `pulse` (boolean), `color` (color pattern, optional)
   - default props: `{ "pulse": true }`
   - enter: `pop`, `fade`. exit: `fade`. colorProps: `["color"]`.
   - description: "A circle that acts as the central node. Other components connect to it with arrows. Can pulse with a ring."

2. `LogoCard`: a white rounded card showing a logo or a name.
   - props: `label` (string, max 40), `logoAssetId` (string, uuid), `variant` (`light` or `dark`). At least one of `label` or `logoAssetId` is required (use `anyOf` with `required`). `additionalProperties: false`.
   - default props: `{ "variant": "light" }`
   - enter: `pop`, `fade`, `slide-up`. exit: `fade`, `shrink`. assetProps: `["logoAssetId"]`.
   - description: "A card with a company logo or name. Use it to introduce a company, product, or person."

3. `Arrow`: a line with a moving dot that connects two other scenes.
   - props: `from` (string, scene id), `to` (string, scene id), `style` (`solid` or `dashed`), `color` (color pattern, optional). Required: `from`, `to`. `additionalProperties: false`.
   - default props: `{ "style": "dashed" }`
   - enter: `draw`, `fade`. exit: `fade`. colorProps: `["color"]`. refProps: `["from", "to"]`.
   - description: "A line from one scene to another. Use it to show flow, ownership, or a connection. Both ends must be scene ids that exist."

4. `CounterPill`: a dark rounded box with a number that counts from one value to another.
   - props: `from` (number), `to` (number), `prefix` (string, default `$`), `suffix` (string, default `B`), `decimals` (integer 0 to 3), `color` (color pattern, optional). Required: `from`, `to`. `additionalProperties: false`.
   - default props: `{ "prefix": "$", "suffix": "B", "decimals": 0 }`
   - enter: `pop`, `fade`. exit: `fade`. colorProps: `["color"]`.
   - description: "A big number that counts up or down. Use it for money, users, percentages, or any changing figure."

5. `Label`: a small tag with text.
   - props: `text` (string, max 80), `color` (color pattern, optional). Required: `text`. `additionalProperties: false`.
   - default props: `{}`
   - enter: `slide-up`, `fade`, `pop`. exit: `fade`. colorProps: `["color"]`.
   - description: "A short text tag. Use it to name or explain something on screen in a few words."

## 14. Phases and acceptance checks

### Phase 0: Scaffold

Create the monorepo, `docker-compose.yml` (Postgres with user/password `app`, database `explainer`, port 5432, named volume; Redis on 6379), base tsconfig, ESLint, Prettier, Vitest, `.env.example`, `.gitignore` (include `storage/` and `.env`).
Root scripts: `dev:api`, `dev:worker`, `build`, `typecheck`, `lint`, `test`, `db:generate`, `db:migrate`, `db:seed`.
Checks: `docker compose up -d` works. `pnpm typecheck` and `pnpm lint` pass on the empty packages.

### Phase 1: Schema package

Implement section 7 and section 8 in `packages/schema`, including `defaultSpec()` and all unit tests.
Checks: `pnpm test` passes. The example spec from section 7 parses with `VideoSpecSchema`. A test proves each semantic rule fails when it should.

### Phase 2: Database

Implement section 6 in `packages/db`, generate and run the migration, implement the seed from section 13.
Checks: `pnpm db:migrate` and `pnpm db:seed` succeed. Running the seed twice creates no duplicates. Show `select name from components` returning 5 rows.

### Phase 3: API core

Fastify server, config, error handler (all errors use the format in section 2), CORS, `GET /health`, Projects endpoints, Components endpoints, and `POST /projects/:id/validate`. Use Fastify `inject` in tests.
Checks: tests cover create, read, update, delete for projects, a 422 on a bad spec, and 409 on duplicate component name. Project with the example spec from section 7 saves successfully (after the seed).

### Phase 4: Assets and transcription

StorageProvider (local disk under `STORAGE_DIR`), assets endpoints, `TranscriptionProvider` with the OpenAI implementation, transcript endpoints. In tests, use a fake provider.
Checks: upload a small audio file, list it, stream it back, delete it. Transcribe with the fake provider and read the transcript back.

### Phase 5: Generate

Implement section 10. In tests, mock the Anthropic client. Test: valid output is saved; invalid output triggers exactly one retry; two invalid outputs return 422 and save nothing; the existing theme is preserved.
Checks: `pnpm test` passes. With real keys in `.env`, one manual call to `POST /projects/:id/generate` returns a valid spec (show the result).

### Phase 6: Renders

Queue producer, renders endpoints, and the worker with the stub renderer (section 12).
Checks: run API and worker. `POST /projects/:id/renders` returns 202. Polling `GET /renders/:id` shows `queued`, then `running` with growing progress, then `done`. `GET /renders/:id/file` returns the placeholder file. A failing renderer sets `failed` with an error message (add a test for this).

### Phase 7: README

Write `README.md` at the root with: what the project is, how to install, how to start Postgres and Redis, how to run migrate, seed, API, worker, and a curl example for each endpoint group.

## 15. Out of scope (do not build)

- Frontend, Remotion components, or the real Remotion renderer
- Login, users, teams, permissions
- Spec version history
- Cloud storage (S3, R2)
- WebSockets or server-sent events (the frontend will poll)
- Deployment files, CI pipelines, Kubernetes
- Any component beyond the five seeds
