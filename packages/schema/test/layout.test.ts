import { describe, expect, it } from 'vitest';
import {
  LayoutIntentSchema,
  LAYOUT_INTENT_TYPES,
  LAYOUT_OVERLAP_INTENTIONAL,
  LAYOUT_OVERLAP_STYLE_KEY,
  StyleSchema,
  intentionalOverlapStyle,
  parseLayoutIntent,
} from '../src/index.js';

/**
 * Stage 4C — semantic layout intent schema.
 *
 * The schema is the contract between AI plans / editor calls and the
 * deterministic layout engine: it validates intent (never raw coordinates
 * for multi-object arrangement) and carries sensible defaults so the engine
 * always receives a complete, bounded request.
 */

const MINIMAL: Record<string, unknown> = {
  horizontal: { type: 'horizontal' },
  vertical: { type: 'vertical' },
  grid: { type: 'grid' },
  center: { type: 'center' },
  stack: { type: 'stack' },
  align: { type: 'align', axis: 'x', mode: 'min' },
  distribute: { type: 'distribute', axis: 'y' },
  flow: { type: 'flow' },
  fitText: { type: 'fitText' },
  constrain: { type: 'constrain' },
  detectOverlaps: { type: 'detectOverlaps' },
  resolveCollisions: { type: 'resolveCollisions' },
};

describe('LayoutIntentSchema', () => {
  it('declares every supported intent type', () => {
    expect(Object.keys(MINIMAL).sort()).toEqual([...LAYOUT_INTENT_TYPES].sort());
  });

  it('parses every declared intent type with minimal payloads', () => {
    for (const [type, payload] of Object.entries(MINIMAL)) {
      const parsed = parseLayoutIntent(payload);
      expect(parsed.type).toBe(type);
    }
  });

  it('fills packing defaults (gap, justify, align)', () => {
    const parsed = parseLayoutIntent(MINIMAL.horizontal);
    expect(parsed).toEqual({ type: 'horizontal', gap: 16, justify: 'start', align: 'start' });

    const vertical = parseLayoutIntent(MINIMAL.vertical);
    expect(vertical).toMatchObject({ gap: 16, justify: 'start', align: 'start' });

    const grid = parseLayoutIntent(MINIMAL.grid);
    expect(grid).toMatchObject({ gapX: 16, gapY: 16 });

    const flow = parseLayoutIntent(MINIMAL.flow);
    expect(flow).toMatchObject({ direction: 'horizontal', gap: 60, align: 'start' });
  });

  it('fills composition defaults', () => {
    expect(parseLayoutIntent(MINIMAL.center)).toEqual({ type: 'center', mode: 'block' });
    expect(parseLayoutIntent(MINIMAL.stack)).toEqual({ type: 'stack', equalizeSize: false });
    expect(parseLayoutIntent(MINIMAL.detectOverlaps)).toEqual({
      type: 'detectOverlaps',
      scope: 'targets',
    });
    expect(parseLayoutIntent(MINIMAL.fitText)).toEqual({
      type: 'fitText',
      paddingX: 0,
      paddingY: 0,
    });
  });

  it('rejects unknown intent types', () => {
    expect(() => parseLayoutIntent({ type: 'shove' })).toThrow();
    expect(() => parseLayoutIntent({})).toThrow();
    expect(() => parseLayoutIntent('horizontal')).toThrow();
  });

  it('rejects out-of-bounds numeric options', () => {
    expect(() => parseLayoutIntent({ type: 'horizontal', gap: -1 })).toThrow();
    expect(() => parseLayoutIntent({ type: 'horizontal', gap: 4001 })).toThrow();
    expect(() => parseLayoutIntent({ type: 'grid', columns: 0 })).toThrow();
    expect(() => parseLayoutIntent({ type: 'grid', columns: 51 })).toThrow();
    expect(() => parseLayoutIntent({ type: 'fitText', fontSize: 0 })).toThrow();
    expect(() => parseLayoutIntent({ type: 'resolveCollisions', maxPasses: 0 })).toThrow();
    expect(() => parseLayoutIntent({ type: 'resolveCollisions', maxPasses: 101 })).toThrow();
  });

  it('requires axis/mode where semantics demand them', () => {
    expect(() => parseLayoutIntent({ type: 'align' })).toThrow();
    expect(() => parseLayoutIntent({ type: 'align', axis: 'x' })).toThrow();
    expect(() => parseLayoutIntent({ type: 'align', axis: 'up', mode: 'min' })).toThrow();
    expect(() => parseLayoutIntent({ type: 'distribute' })).toThrow();
  });

  it('strips unknown fields instead of failing', () => {
    const parsed = parseLayoutIntent({ type: 'horizontal', rawCoordinates: [1, 2, 3] });
    expect(parsed).not.toHaveProperty('rawCoordinates');
  });
});

describe('LayoutContainerSchema', () => {
  it('accepts the canvas container', () => {
    const parsed = parseLayoutIntent({ type: 'center', container: { kind: 'canvas' } });
    expect(parsed).toMatchObject({ container: { kind: 'canvas' } });
  });

  it('accepts instance containers addressed by id or clientKey', () => {
    expect(() =>
      parseLayoutIntent({
        type: 'horizontal',
        container: { kind: 'instance', instanceId: '11111111-1111-4111-8111-111111111111' },
      }),
    ).not.toThrow();
    expect(() =>
      parseLayoutIntent({
        type: 'horizontal',
        container: { kind: 'instance', instanceClientKey: 'card' },
      }),
    ).not.toThrow();
  });

  it('accepts group containers addressed by id or clientKey', () => {
    expect(() =>
      parseLayoutIntent({
        type: 'grid',
        container: { kind: 'group', groupId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).not.toThrow();
    expect(() =>
      parseLayoutIntent({
        type: 'grid',
        container: { kind: 'group', groupClientKey: 'g1' },
      }),
    ).not.toThrow();
  });

  it('rejects containers missing their id and containers mixing kinds', () => {
    expect(() => parseLayoutIntent({ type: 'center', container: { kind: 'instance' } })).toThrow();
    expect(() => parseLayoutIntent({ type: 'center', container: { kind: 'group' } })).toThrow();
    expect(() =>
      parseLayoutIntent({
        type: 'center',
        container: { kind: 'canvas', instanceId: '11111111-1111-4111-8111-111111111111' },
      }),
    ).toThrow();
    expect(() =>
      parseLayoutIntent({
        type: 'center',
        container: {
          kind: 'instance',
          instanceClientKey: 'card',
          groupId: '99999999-9999-4999-8999-999999999999',
        },
      }),
    ).toThrow();
    expect(() =>
      parseLayoutIntent({
        type: 'center',
        container: {
          kind: 'group',
          groupClientKey: 'g1',
          instanceId: '11111111-1111-4111-8111-111111111111',
        },
      }),
    ).toThrow();
  });
});

describe('intentional overlap marking', () => {
  it('StyleSchema accepts the layoutOverlap marker (catchall style)', () => {
    const style = StyleSchema.parse({
      opacity: 0.5,
      [LAYOUT_OVERLAP_STYLE_KEY]: LAYOUT_OVERLAP_INTENTIONAL,
    });
    expect(style).toMatchObject({ opacity: 0.5, layoutOverlap: 'intentional' });
  });

  it('builds patches that mark or clear an intentional overlap', () => {
    expect(intentionalOverlapStyle(true)).toEqual({ layoutOverlap: 'intentional' });
    expect(intentionalOverlapStyle(false)).toEqual({ layoutOverlap: null });
  });
});

describe('LayoutIntentSchema union coverage', () => {
  it('keeps the discriminated union in sync with LAYOUT_INTENT_TYPES', () => {
    const result = LayoutIntentSchema.safeParse({ type: 'teleport' });
    expect(result.success).toBe(false);
    for (const type of LAYOUT_INTENT_TYPES) {
      expect(
        LayoutIntentSchema.safeParse(MINIMAL[type]).success,
        `intent type ${type} must parse`,
      ).toBe(true);
    }
  });
});
