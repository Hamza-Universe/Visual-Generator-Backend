# Implementation Checklist

Audit date: 2026-10-01

This file tracks work that is started, incomplete, or not yet production-ready. It is based on the current source tree and both backend specification revisions.

## P0: Blocks a complete end-to-end user flow

- [x] **Implement password-reset email delivery**
  - `apps/api/src/routes/auth.ts` creates and stores a reset-token hash, but the raw token is discarded and no email is sent.
  - Add a mail provider abstraction, delivery configuration, reset URL configuration, and a real email containing the reset link.
  - Preserve the generic forgot-password response so account existence is not disclosed.
  - Add tests for delivery invocation, token expiry, one-time use, and failure handling.

- [x] **Make authenticated MCP requests work**
  - `apps/mcp/src/tools.ts` calls the API without an `Authorization` header.
  - The API protects non-auth routes in `apps/api/src/index.ts`, so project, generation, asset, and render MCP tools currently receive `401` unless authentication is bypassed.
  - Choose and document one model: a configured MCP service token, per-client bearer-token forwarding, or a dedicated MCP credential exchange.
  - Add configuration without logging or exposing tokens, then test a protected tool call.

- [ ] **Finish real render input integration**
  - The worker now parses `renders.specSnapshot` and passes `spec` to `renderProject`, but it does not resolve or pass the audio asset path.
  - Rendering currently cannot include the narrated audio track.
  - Add secure asset-path resolution and pass audio input through the renderer.

## P1: Remotion/rendering work that has started but is incomplete

- [x] **Complete the component registry to Remotion mapping**
  - `apps/worker/src/remotion/video.tsx` maps only hard-coded aliases such as `title-card`, `text`, `diagram-node`, and `code-block`.
  - The database registry seed uses components such as `Hub`, `LogoCard`, `Arrow`, `CounterPill`, and `Label`; these currently fall through to `FallbackComponent`.
  - Define a canonical naming contract and implement a dedicated Remotion component for every supported registry component, or explicitly reject unsupported components before queuing.
  - Keep the backend registry and renderer map synchronized through tests or a shared manifest.

- [x] **Implement scene transition semantics**
  - `SceneLayer` applies one generic opacity/translate animation regardless of `enter.style`, `exit.style`, and `easing`.
  - Implement the registered styles (`pop`, `fade`, `slide-up`, `draw`, `shrink`, etc.) and honor easing and global speed.
  - Add frame-level tests or render snapshots for each supported style.

- [x] **Render image backgrounds and asset-backed props**
  - `backgroundStyle` uses a dark fallback for `background.type === 'image'` instead of loading the referenced asset.
  - Components do not resolve `assetProps` such as `logoAssetId` into media URLs/files.
  - Add an asset manifest passed to the composition and render image/logo assets safely.

- [x] **Render side-video overlays**
  - `spec.sideVideo` is validated and accepted, but `VideoComposition` does not render it.
  - Implement picture-in-picture positioning, size, shape, and video playback using the referenced asset.
  - Add tests for all supported shapes and missing/invalid media behavior.

- [x] **Use real output metadata and clean temporary files**
  - `apps/worker/src/index.ts` stores `sizeBytes: 0` for completed render assets.
  - The temporary render file is not removed after storage succeeds or fails.
  - Calculate file size and clean temporary files in a `finally` path.

- [x] **Throttle render progress updates**
  - The worker writes a database update on every Remotion `onProgress` callback.
  - Apply the specification's once-per-second throttle and ensure progress reaches 100 on success.

- [ ] **Add a direct Remotion smoke/integration test**
  - The worker has a real Remotion bundling/render path, but there is no committed test proving that a minimal spec produces a playable MP4.
  - Add a focused smoke test or documented local render command, including the Windows entrypoint path behavior.

## P1: Authentication and authorization gaps

- [x] **Apply user ownership checks to all protected resources**
  - Authentication is enforced globally, but routes currently query projects, assets, transcripts, components, and renders without consistently restricting records to `request.user.id`.
  - Add ownership rules and decide whether components are global while projects/assets/transcripts/renders are user-owned.
  - Add cross-user access tests for read, update, delete, generation, and render operations.

- [ ] **Harden JWT verification edge cases**
  - `AuthService.verifyToken` uses `timingSafeEqual` without first checking equal buffer lengths; malformed signatures can throw a low-level exception instead of a controlled auth error.
  - Validate JWT header/algorithm and normalize all malformed-token failures to the API's `401` response.
  - Add tests for malformed, tampered, expired, and structurally invalid tokens.

- [ ] **Improve reset-token lookup and concurrency behavior**
  - `/auth/reset-password` loads all reset-token rows and compares them in application code.
  - Add an indexed lookup strategy, token expiry cleanup, and an atomic used-token update or transaction to prevent concurrent reuse.

- [ ] **Add rate limiting and abuse protection**
  - Registration, login, forgot-password, reset-password, upload, and generation routes have no rate limits.
  - Add production-appropriate throttling and request-size controls, especially around password reset and AI generation.

## P1: Transcription and media processing gaps

- [x] **Implement the documented ffmpeg preprocessing path**
  - `apps/api/src/services/transcription.ts` checks whether ffmpeg exists but does not extract audio from video or oversized files before calling Whisper.
  - Implement temporary mono 16 kHz conversion, cleanup, and error reporting.
  - Call `checkFfmpeg` during startup and cover the preprocessing path with tests.

- [ ] **Validate transcription configuration before making provider calls**
  - The API constructs `GeminiTranscriptionProvider` even when the transcription key is empty.
  - Return the documented `MISSING_CONFIG` error before attempting an external request.

- [x] **Improve upload metadata and media validation**
  - Asset kind is stored as free-form text rather than a database/application enum.
  - Validate MIME type, extension, file size, and allowed kind combinations; derive or verify duration where required.

## P1: API contract and request-validation gaps

- [ ] **Validate request bodies, params, and queries consistently with Zod**
  - Several routes cast `request.body` and `request.params` directly instead of using `safeParse`.
  - Audit projects, components, assets, transcripts, generation, and render routes and ensure malformed input always uses the standard error shape.

- [ ] **Align `openapi.json` with the actual API**
  - The document exists, but several operations have response descriptions without schemas and some request bodies are underspecified or missing.
  - Add complete request/response schemas, auth requirements, error responses, multipart details, pagination/filter parameters, and render/file content types.
  - Add a JSON/OpenAPI validation check to CI or the test suite.

- [ ] **Generate or maintain OpenAPI from one source of truth**
  - `openapi.json` is manually maintained and can drift from route behavior.
  - Either add a generation step or document a tested update process.

- [ ] **Resolve API route ownership and authorization consistently**
  - The global auth hook protects routes, but the OpenAPI contract and MCP descriptions do not communicate how credentials are supplied to MCP tools.
  - Update the contract after the MCP auth design is selected.

## P2: AI generation cleanup and reliability

- [x] **Remove or reconcile the legacy generator implementation**
  - `apps/api/src/services/generator.ts` remains alongside the newer `apps/api/src/services/ai/` implementation.
  - Decide whether it is a compatibility layer or dead code; remove it or route all generation through the shared provider abstraction.

- [x] **Use the generated VideoSpec JSON Schema with direct providers**
  - The Gemini provider uses the shared generation contract and JSON response mode.
  - Ensure every direct provider uses the complete schema and has provider-specific response parsing tests.

- [x] **Validate generation request fields**
  - `apps/api/src/routes/generate.ts` uses direct body casts for provider, model, API key, base URL, transcript ID, instructions, and save.
  - Add Zod validation, provider enum validation, URL validation, length limits, and safe handling of per-request secrets.

- [ ] **Add integration tests for all generation modes**
  - Cover Gemini, manual prompt, manual submit, retry behavior, theme preservation, component budgets, malformed JSON, semantic failures, and `save: false`.
  - Confirm no request API key is logged, persisted, or returned.

## P2: MCP completeness and operations

- [x] **Add MCP integration tests**
  - Verify stdio startup, streamable HTTP startup, exactly nine tools, tool input validation, API error propagation, and protected API calls.

- [ ] **Improve MCP HTTP server lifecycle**
  - `apps/mcp/src/index.ts` creates a new transport/server for every HTTP request and does not visibly restrict HTTP methods or handle transport errors centrally.
  - Add request method handling, error responses, graceful shutdown, and deployment configuration.

- [x] **Document MCP client setup**
  - Add Claude Desktop/Claude Code configuration examples, API authentication requirements, `API_BASE_URL`, and stdio versus HTTP usage to `README.md`.

## P2: Tests, documentation, and operational readiness

- [ ] **Expand test coverage beyond the current auth/schema tests**
  - Add API route tests with Fastify inject, database integration tests, worker failure tests, render tests, MCP tests, asset/transcription tests, and authorization tests.

- [x] **Update README.md**
  - It documents the original unauthenticated flow and does not cover registration/login, JWT headers, password reset limitations/email setup, manual AI mode, MCP, Remotion rendering, or the expanded OpenAPI contract.
  - Add setup requirements for PostgreSQL, Redis, ffmpeg, Remotion rendering, and environment variables.

- [ ] **Add production environment documentation**
  - Document required secrets, JWT secret rotation, email provider settings, frontend reset URL, AI provider settings, storage behavior, and MCP credentials.

- [ ] **Add CI/build verification**
  - Run build, typecheck, lint, tests, OpenAPI validation, and a worker Remotion smoke test in a repeatable pipeline.
  - Confirm Windows and Linux path behavior for the Remotion entrypoint.

- [ ] **Add database migration/seed verification**
  - Verify migrations from a clean database, idempotent seeding, ownership columns/indexes, password-reset indexes, and `side_video`/`max_components` changes.

## Intentionally outside the current backend scope

These are not counted as started-but-incomplete backend work unless the product scope changes:

- [ ] Frontend React application and Remotion Player UI.
- [ ] A larger production component library beyond the currently seeded components.
- [ ] Cloud object storage such as S3/R2.
- [ ] WebSockets or server-sent events; current render status design uses polling.
- [ ] Deployment manifests, CI hosting, Kubernetes, and production infrastructure.
- [ ] Teams, roles, sharing, billing, and collaborative permissions.
- [ ] Spec version history and undo/redo.

## Suggested implementation order

1. Finish password-reset email delivery and authenticated MCP access.
2. Complete ownership checks and request validation.
3. Finish Remotion asset/audio/side-video rendering and component coverage.
4. Add API, worker, MCP, and auth integration tests.
5. Align OpenAPI and README with the actual authenticated system.
6. Add rate limiting, media preprocessing, cleanup, and production operations.
