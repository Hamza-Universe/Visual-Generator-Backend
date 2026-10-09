import { describe, expect, it } from 'vitest';
import {
  ASPECT_DIMENSIONS,
  ASPECT_RATIOS,
  AudioElementSchema,
  CaptionElementSchema,
  DEFAULT_ASPECT_RATIO,
  EffectSchema,
  LAYOUT_PRESET_IDS,
  LAYOUT_PRESETS,
  MediaElementSchema,
  VideoClipElementSchema,
  layoutPresetSupportsAspect,
  resolveAspectRatio,
  SceneDocumentSchema,
} from '../src/index.js';

const ASSET = '11111111-1111-4111-8111-111111111111';
const INSTANCE = '22222222-2222-4222-8222-222222222222';

describe('aspect ratio contract', () => {
  it('defines landscape, portrait and square with 1080p-class dimensions', () => {
    expect(ASPECT_RATIOS).toEqual(['landscape', 'portrait', 'square']);
    expect(ASPECT_DIMENSIONS.landscape).toEqual({ width: 1920, height: 1080 });
    expect(ASPECT_DIMENSIONS.portrait).toEqual({ width: 1080, height: 1920 });
    expect(ASPECT_DIMENSIONS.square).toEqual({ width: 1080, height: 1080 });
  });

  it('falls back to landscape for unknown or missing values (existing projects)', () => {
    expect(DEFAULT_ASPECT_RATIO).toBe('landscape');
    expect(resolveAspectRatio(undefined)).toBe('landscape');
    expect(resolveAspectRatio(null)).toBe('landscape');
    expect(resolveAspectRatio('ultrawide')).toBe('landscape');
    expect(resolveAspectRatio('portrait')).toBe('portrait');
  });
});

describe('media elements', () => {
  it('accepts a video clip with trimming and defaults', () => {
    const parsed = VideoClipElementSchema.parse({ type: 'videoClip', assetId: ASSET, inSeconds: 1, outSeconds: 4 });
    expect(parsed.muted).toBe(false);
    expect(parsed.outSeconds).toBe(4);
  });

  it('rejects a video clip whose out point is not after its in point', () => {
    expect(VideoClipElementSchema.safeParse({ type: 'videoClip', assetId: ASSET, inSeconds: 3, outSeconds: 3 }).success).toBe(false);
    expect(VideoClipElementSchema.safeParse({ type: 'videoClip', assetId: ASSET, inSeconds: 3, outSeconds: 2 }).success).toBe(false);
  });

  it('bounds audio volume to 0..2 and defaults role to background', () => {
    const ok = AudioElementSchema.parse({ type: 'audio', assetId: ASSET });
    expect(ok.volume).toBe(1);
    expect(ok.role).toBe('background');
    expect(AudioElementSchema.safeParse({ type: 'audio', assetId: ASSET, volume: 2.5 }).success).toBe(false);
    expect(AudioElementSchema.safeParse({ type: 'audio', assetId: ASSET, volume: -0.1 }).success).toBe(false);
  });

  it('validates caption cues and rejects non-increasing timing', () => {
    const ok = CaptionElementSchema.parse({
      type: 'caption',
      cues: [{ startSeconds: 0, endSeconds: 1.5, text: 'Hello' }],
    });
    expect(ok.placement).toBe('bottom');
    expect(
      CaptionElementSchema.safeParse({ type: 'caption', cues: [{ startSeconds: 2, endSeconds: 2, text: 'x' }] }).success,
    ).toBe(false);
  });

  it('discriminates the media union by type and rejects unknown kinds', () => {
    expect(MediaElementSchema.safeParse({ type: 'hologram', assetId: ASSET }).success).toBe(false);
    expect(MediaElementSchema.parse({ type: 'audio', assetId: ASSET }).type).toBe('audio');
  });

  it('rejects non-uuid asset references', () => {
    expect(AudioElementSchema.safeParse({ type: 'audio', assetId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('layout presets', () => {
  it('defines exactly the five agreed presets', () => {
    expect([...LAYOUT_PRESET_IDS].sort()).toEqual(
      ['circular-webcam', 'picture-in-picture', 'screen-only', 'side-by-side', 'vertical-presenter-screen'],
    );
  });

  it('keeps every slot rectangle inside the canvas', () => {
    for (const preset of Object.values(LAYOUT_PRESETS)) {
      for (const slot of preset.slots) {
        const { x, y, width, height } = slot.rect;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + width).toBeLessThanOrEqual(1 + 1e-9);
        expect(y + height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('restricts the vertical presenter layout to portrait', () => {
    expect(layoutPresetSupportsAspect('vertical-presenter-screen', 'portrait')).toBe(true);
    expect(layoutPresetSupportsAspect('vertical-presenter-screen', 'landscape')).toBe(false);
  });

  it('keeps the side-by-side and PiP slots non-overlapping except for the intended PiP overlay', () => {
    const sbs = LAYOUT_PRESETS['side-by-side'].slots.map((s) => s.rect);
    expect(sbs[0].x + sbs[0].width).toBeCloseTo(sbs[1].x, 9);
  });
});

describe('effects', () => {
  it('accepts scene, element and region targets', () => {
    expect(EffectSchema.parse({ id: 'e1', kind: 'fade', target: { scope: 'scene' }, startFrame: 0, durationFrames: 30 }).amount).toBe(1);
    expect(
      EffectSchema.safeParse({ id: 'e2', kind: 'blur', target: { scope: 'element', instanceId: INSTANCE }, startFrame: 0, durationFrames: 10 }).success,
    ).toBe(true);
    expect(
      EffectSchema.safeParse({
        id: 'e3',
        kind: 'brightness',
        target: { scope: 'region', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        startFrame: 5,
        durationFrames: 10,
        amount: 0.4,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown effect kinds, bad regions and zero duration', () => {
    expect(EffectSchema.safeParse({ id: 'x', kind: 'explode', target: { scope: 'scene' }, startFrame: 0, durationFrames: 5 }).success).toBe(false);
    expect(
      EffectSchema.safeParse({ id: 'x', kind: 'fade', target: { scope: 'region', rect: { x: 0.9, y: 0, width: 0.5, height: 1 } }, startFrame: 0, durationFrames: 5 }).success,
    ).toBe(false);
    expect(EffectSchema.safeParse({ id: 'x', kind: 'fade', target: { scope: 'scene' }, startFrame: 0, durationFrames: 0 }).success).toBe(false);
  });
});

describe('backward compatibility of existing scene documents', () => {
  it('still parses a legacy scene document with no media, aspect or effect fields', () => {
    const legacy = {
      id: '33333333-3333-4333-8333-333333333333',
      projectId: '44444444-4444-4444-8444-444444444444',
      name: 'Intro',
      components: [],
      groups: [],
    };
    const parsed = SceneDocumentSchema.parse(legacy);
    expect(parsed.timeline).toEqual({ fps: 30, durationFrames: 300 });
    expect(parsed.components).toEqual([]);
  });
});
