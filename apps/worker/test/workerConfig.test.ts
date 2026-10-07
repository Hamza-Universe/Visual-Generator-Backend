import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  DATABASE_URL: 'postgres://app:app@localhost:5432/explainer',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_DIR: './storage',
};

const withEnv = (overrides: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe('worker config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllEnvs();
  });

  it('defaults to safe operational values', () => {
    withEnv({ ...REQUIRED, RENDER_WORKER_CONCURRENCY: undefined, RENDER_TIMEOUT_MS: undefined });
    const config = loadConfig();
    expect(config.RENDER_WORKER_CONCURRENCY).toBe(1);
    expect(config.RENDER_TIMEOUT_MS).toBe(600000);
  });

  it('accepts configured concurrency and timeout', () => {
    withEnv({ ...REQUIRED, RENDER_WORKER_CONCURRENCY: '3', RENDER_TIMEOUT_MS: '900000' });
    const config = loadConfig();
    expect(config.RENDER_WORKER_CONCURRENCY).toBe(3);
    expect(config.RENDER_TIMEOUT_MS).toBe(900000);
  });

  it('rejects unsafe concurrency instead of starting degraded', () => {
    withEnv({ ...REQUIRED, RENDER_WORKER_CONCURRENCY: '0' });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const silence = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => loadConfig()).toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
    silence.mockRestore();
  });
});
