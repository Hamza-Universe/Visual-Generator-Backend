import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type OpenApiDocument = {
  paths: Record<
    string,
    Record<
      string,
      { responses?: Record<string, unknown>; security?: unknown[] }
    >
  >;
  components?: Record<string, unknown>;
  security?: unknown[];
};
const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'),
) as OpenApiDocument;

const pointerValue = (root: unknown, pointer: string): unknown =>
  pointer
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[
              part.replaceAll('~1', '/').replaceAll('~0', '~')
            ]
          : undefined,
      root,
    );
const collectRefs = (value: unknown, refs: string[] = []): string[] => {
  if (Array.isArray(value)) for (const item of value) collectRefs(item, refs);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      key === '$ref' && typeof item === 'string'
        ? refs.push(item)
        : collectRefs(item, refs);
  return refs;
};

describe('OpenAPI contract', () => {
  it('is valid JSON with resolvable local references and responses', () => {
    expect(document.paths).toBeDefined();
    for (const operations of Object.values(document.paths))
      for (const operation of Object.values(operations))
        expect(
          operation.responses && Object.keys(operation.responses).length,
        ).toBeGreaterThan(0);
    for (const ref of collectRefs(document))
      if (ref.startsWith('#/'))
        expect(pointerValue(document, ref)).toBeDefined();
  });

  it('marks health and auth endpoints as public', () => {
    expect(document.paths['/health'].get.security).toEqual([]);
    expect(document.paths['/auth/login'].post.security).toEqual([]);
    expect(document.paths['/auth/register'].post.security).toEqual([]);
    expect(document.paths['/auth/forgot-password'].post.security).toEqual([]);
    expect(document.paths['/auth/reset-password'].post.security).toEqual([]);
  });
});
