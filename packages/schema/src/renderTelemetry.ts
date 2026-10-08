/**
 * Render usage telemetry (Stage 3G).
 *
 * Minimal server-side audit trail for the VideoSpec deprecation decision.
 * Events are small structured objects (never full spec/document payloads)
 * emitted through each host's existing logging convention:
 *   - API: `request.log.info(event)` (pino)
 *   - worker: `console.info(JSON.stringify(event))`
 *
 * Pure builders + a sink-injectable emitter keep this unit-testable without
 * any analytics platform, database table, or schema change.
 */

export const RENDER_SOURCE_SCENE_DOCUMENT = 'scene-document' as const;
export const RENDER_SOURCE_VIDEO_SPEC = 'video-spec' as const;

export type RenderTelemetrySource =
  | typeof RENDER_SOURCE_SCENE_DOCUMENT
  | typeof RENDER_SOURCE_VIDEO_SPEC;

export type RenderTelemetryKind = 'requested' | 'succeeded' | 'failed';

export interface RenderTelemetryEvent {
  /** Stable marker so log aggregators can filter telemetry lines. */
  readonly telemetry: 'render';
  readonly event: RenderTelemetryKind;
  readonly source: RenderTelemetrySource;
  readonly renderId: string;
  readonly projectId: string;
  readonly sceneId: string | null;
  /** ISO-8601 timestamp of event construction. */
  readonly timestamp: string;
  /** 1-based BullMQ attempt that produced this event (worker only). */
  readonly attempt?: number;
  /** Wall-clock job duration in ms (terminal worker events only). */
  readonly durationMs?: number;
}

export const buildRenderTelemetryEvent = (input: {
  event: RenderTelemetryKind;
  source: RenderTelemetrySource;
  renderId: string;
  projectId: string;
  sceneId?: string | null;
  timestamp?: string;
  attempt?: number;
  durationMs?: number;
}): RenderTelemetryEvent => ({
  telemetry: 'render',
  event: input.event,
  source: input.source,
  renderId: input.renderId,
  projectId: input.projectId,
  sceneId: input.sceneId ?? null,
  timestamp: input.timestamp ?? new Date().toISOString(),
  ...(typeof input.attempt === 'number' ? { attempt: input.attempt } : {}),
  ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
});

export type TelemetrySink = (event: RenderTelemetryEvent) => void;

/** Emit through the host's logger; never throws (telemetry is best-effort). */
export const emitRenderTelemetry = (
  sink: TelemetrySink,
  event: RenderTelemetryEvent,
): void => {
  try {
    sink(event);
  } catch {
    // Telemetry must never break rendering or request handling.
  }
};
