# Visual Diagram Gen

Backend for turning narrated audio or video into validated animation specifications and rendered explainer videos.

## Setup

Requirements:

- Node.js current LTS
- pnpm
- PostgreSQL
- Redis
- ffmpeg for video or oversized transcription preprocessing

Install and start local services:

```powershell
pnpm install
docker compose up -d
Copy-Item .env.example .env
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

Set a long random `JWT_SECRET`. For password reset email delivery, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, and `PASSWORD_RESET_URL`.

Run the API and render worker together:

```powershell
pnpm dev:all
```

The API listens on `http://localhost:3001`. The MCP server uses `http://localhost:3001` by default.

## Authentication

Registration and login are public:

```powershell
$register = Invoke-RestMethod http://localhost:3001/auth/register -Method Post -ContentType 'application/json' -Body '{"name":"Alice Example","email":"alice@example.com","password":"StrongPass!123"}'
$token = $register.token
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod http://localhost:3001/projects -Headers $headers
```

Protected projects, assets, transcripts, generation, and render operations are scoped to the authenticated user. A resource owned by another user is returned as not found.

Password reset uses this flow:

1. `POST /auth/forgot-password` with `{ "email": "..." }`.
2. The API sends an SMTP reset link to the account email.
3. The frontend submits the link token and a new password to `POST /auth/reset-password`.

The forgot-password response is intentionally generic whether or not the email exists.

## AI generation

Direct provider mode uses `POST /projects/:id/generate` with Gemini. Set `GEMINI_API_KEY` and optionally `AI_MODEL` (default `gemini-2.0-flash`). Per-request API keys are used in memory only and are never stored or logged.

Manual mode requires no provider key:

1. Call `POST /projects/:id/generate/manual-prompt`.
2. Paste `promptText` into any AI chat.
3. Send the returned text to `POST /projects/:id/generate/manual-submit`.
4. The backend parses and validates the resulting spec before saving it.

## Assets and transcription

Upload audio, video, image, logo, or side-video assets through `POST /assets`. Asset MIME types are checked against their declared kind. Audio/video transcription uses Gemini with word timestamps. Video is converted by ffmpeg to mono 16 kHz MP3 before upload.

## Rendering

`POST /projects/:id/renders` queues a BullMQ job. The worker resolves only owner-owned referenced assets and renders them through Remotion, including:

- seeded animation components
- palette colors and transitions
- image backgrounds and logos
- audio tracks
- circular, rounded, or square side-video overlays

Poll `GET /renders/:id` until the status is `done`, then download `GET /renders/:id/file`.

The API checks for a connected render worker before accepting a render request and returns `503 RENDER_WORKER_UNAVAILABLE` when the worker is stopped, instead of leaving a job queued indefinitely.

## MCP

MCP uses a real API JWT for the configured user. Set:

```env
API_BASE_URL=http://localhost:3001
MCP_TRANSPORT=stdio
MCP_API_TOKEN=<JWT returned by /auth/login>
```

Start the local MCP server:

```powershell
pnpm dev:mcp
```

It exposes nine tools: project/component listing, project reads, spec validation, direct generation, manual prompt generation, manual submission, render creation, and render status.

For streamable HTTP, set `MCP_TRANSPORT=http`. The MCP HTTP endpoint listens on port `3002` and requires `Authorization: Bearer <MCP_API_TOKEN>`. Put TLS and authentication at the reverse proxy in production.

## API contract

The frontend contract is [openapi.json](openapi.json). It documents bearer authentication, public auth routes, project/asset/transcript/generation/render operations, multipart uploads, reset-password flow, and standard API errors.

## Checks

```powershell
pnpm test
pnpm build
pnpm lint
```

## Deliberate scope

The backend does not include a frontend application, cloud object storage, push render updates, teams/roles/sharing/billing, spec version history, deployment manifests, Kubernetes, or an unrestricted component-authoring system. Render status uses polling and the component registry remains global.
