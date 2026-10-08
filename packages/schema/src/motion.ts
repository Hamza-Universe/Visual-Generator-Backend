import { z } from 'zod';

/**
 * AI motion operation contract (Stage 4D).
 *
 * Wire-shape only: this module owns the Zod contract for the `motion`
 * operation's timing/choreography/options fields plus the server-owned size
 * limits. The motion TAXONOMY (supported primitives, option keys, ranges,
 * defaults, choreography math, compilation to keyframes) lives in the
 * deterministic engine in `@app/render` (`motion.ts`) so every consumer
 * (API validation, apply, verification) shares one implementation and
 * `@app/render` keeps zero dependencies.
 *
 * Numbers are declared as plain `z.number()`; NaN fails the schema (it is
 * not a number) while out-of-range/Infinity values are rejected by the
 * engine's semantic validation with the MOTION_* error codes — domain rules
 * belong to the domain layer, not the wire schema.
 */

/** Max explicit target refs per motion operation (group expansion may add more, bounded by MOTION_TARGET_LIMIT at validation). */
export const MOTION_MAX_TARGETS = 200;
/** Max option keys accepted on one motion operation (server-owned). */
export const MOTION_MAX_OPTION_KEYS = 16;
/** Longest accepted primitive identifier (a name, never code). */
export const MOTION_MAX_PRIMITIVE_LENGTH = 40;

/**
 * Motion timing, in seconds. `start` is the base offset, `delay` waits
 * after it, `duration` is how long the primitive runs, and `end` is an
 * optional consistency check (must equal start + delay + duration).
 * All fields are optional; the engine applies documented defaults.
 */
export const MotionTimingSchema = z.object({
  start: z.number().optional(),
  delay: z.number().optional(),
  duration: z.number().optional(),
  end: z.number().optional(),
});

/**
 * Choreography distributes a primitive across the resolved targets.
 *  - mode `parallel`    — every target starts together.
 *  - mode `stagger`     — rank * stagger between starts.
 *  - mode `sequence`    — chained: rank * (duration + stagger).
 *  - mode `overlap`     — each start pulls in by `overlap` seconds.
 *  - order `forward` / `reverse` — document/plan order or reversed.
 *  - order `centerOut`  — middle first, then outward (ties simultaneous).
 *  - order `edgesIn`    — edges first, then inward (ties simultaneous).
 */
export const MotionChoreographySchema = z.object({
  mode: z.enum(['sequence', 'parallel', 'overlap', 'stagger']).default('parallel'),
  order: z.enum(['forward', 'reverse', 'centerOut', 'edgesIn']).default('forward'),
  stagger: z.number().optional(),
  overlap: z.number().optional(),
});

export type MotionTiming = z.infer<typeof MotionTimingSchema>;
export type MotionChoreography = z.infer<typeof MotionChoreographySchema>;
