import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';

/**
 * Regression: the browser editor saves inspector edits with PATCH. If the CORS
 * preflight does not allow PATCH, the browser blocks the save silently. This
 * test builds the same CORS registration the API uses and checks the preflight.
 */
describe('CORS preflight', () => {
  const build = async () => {
    const app = Fastify();
    await app.register(cors, {
      origin: 'http://localhost:3100',
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });
    app.patch('/instances/:id', async () => ({ ok: true }));
    await app.ready();
    return app;
  };

  it('allows PATCH from the editor origin', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/instances/abc',
      headers: {
        origin: 'http://localhost:3100',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    await app.close();
  });
});
