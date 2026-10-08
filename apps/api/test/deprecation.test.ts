import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Operation = {
  summary?: string;
  description?: string;
  deprecated?: boolean;
  responses?: Record<string, unknown>;
};
type OpenApiDocument = {
  paths: Record<string, Record<string, Operation>>;
};

const document = JSON.parse(
  readFileSync(resolve(process.cwd(), 'openapi.json'), 'utf8'),
) as OpenApiDocument;

describe('render deprecation contract (Stage 3G)', () => {
  it('marks the legacy VideoSpec endpoint deprecated without breaking it', () => {
    const legacy = document.paths['/projects/{id}/renders'].post;
    expect(legacy.deprecated).toBe(true);
    expect(legacy.responses?.['202']).toBeDefined();
    expect(`${legacy.summary ?? ''} ${legacy.description ?? ''}`).toMatch(/legacy/i);
    expect(`${legacy.summary ?? ''} ${legacy.description ?? ''}`).toMatch(
      /\/scenes\/\{id\}\/renders/,
    );
  });

  it('keeps the SceneDocument endpoint current and unaffected', () => {
    const current = document.paths['/scenes/{id}/renders'].post;
    expect(current.deprecated ?? false).toBe(false);
    expect(current.responses?.['202']).toBeDefined();
    expect(`${current.summary ?? ''} ${current.description ?? ''}`).toMatch(/current/i);
  });

  it('documents the lifecycle operations used by the frontend workflow', () => {
    for (const path of [
      '/renders/{id}/status',
      '/renders/{id}/cancel',
      '/scenes/{id}/renders',
    ]) {
      expect(document.paths[path], path).toBeDefined();
      for (const operation of Object.values(document.paths[path])) {
        expect(Object.keys(operation.responses ?? {}).length).toBeGreaterThan(0);
      }
    }
    expect(document.paths['/renders/{id}/cancel'].post.responses?.['200']).toBeDefined();
  });
});
