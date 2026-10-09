import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../src/errors.js';
import { AuthService } from '../src/services/auth.js';
import { requireAdmin, requireAuth } from '../src/routes/auth.js';
import type { Database } from '@app/db';

/**
 * Authentication and administrative authorization foundation.
 *
 * Uses the REAL AuthService (token issue/verify) and the REAL requireAuth /
 * requireAdmin. Only the database is replaced, by a small in-memory store that
 * answers the exact select shapes these guards issue. The role is asserted to
 * come from the database row, never from the token claims.
 */

const SECRET = 'test-secret-for-authorization-suite-0123456789';

type Row = { id: string; name: string; email: string; role: string };

const makeStore = (rows: Row[]) => {
  // Drizzle chain: db.select(...).from(users).where(...) -> Promise<row[]>
  const db = {
    select: () => ({
      from: () => ({
        where: async () => rows.map((row) => ({ ...row })),
      }),
    }),
  };
  return db as unknown as Database;
};

const bearer = (token: string) =>
  ({ headers: { authorization: `Bearer ${token}` } }) as unknown as FastifyRequest;

const auth = new AuthService({
  jwtSecret: SECRET,
  tokenTtlSeconds: 3600,
  passwordMinLength: 12,
  iterations: 1,
  saltLength: 8,
});

const ALICE: Row = { id: '00000000-0000-4000-8000-00000000000a', name: 'Alice', email: 'alice@example.com', role: 'user' };
const ROOT: Row = { id: '00000000-0000-4000-8000-00000000000b', name: 'Root', email: 'root@example.com', role: 'admin' };

const tokenFor = (row: Row) => auth.issueToken({ id: row.id, email: row.email, name: row.name });

const expectAppError = async (promise: Promise<unknown>, code: string, status: number) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).statusCode).toBe(status);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('requireAuth', () => {
  it('rejects a missing Authorization header with 401', async () => {
    const request = { headers: {} } as unknown as FastifyRequest;
    await expectAppError(requireAuth({ request, db: makeStore([ALICE]), jwtSecret: SECRET }), 'UNAUTHORIZED', 401);
  });

  it('rejects a non-Bearer scheme with 401', async () => {
    const request = { headers: { authorization: 'Basic abc' } } as unknown as FastifyRequest;
    await expectAppError(requireAuth({ request, db: makeStore([ALICE]), jwtSecret: SECRET }), 'UNAUTHORIZED', 401);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = new AuthService({ jwtSecret: 'other-secret-0123456789abcdef', tokenTtlSeconds: 3600, passwordMinLength: 12, iterations: 1, saltLength: 8 }).issueToken({ id: ALICE.id, email: ALICE.email, name: ALICE.name });
    await expect(requireAuth({ request: bearer(forged), db: makeStore([ALICE]), jwtSecret: SECRET })).rejects.toBeTruthy();
  });

  it('rejects a valid token whose user no longer exists', async () => {
    await expectAppError(
      requireAuth({ request: bearer(tokenFor(ALICE)), db: makeStore([]), jwtSecret: SECRET }),
      'UNAUTHORIZED',
      401,
    );
  });

  it('returns the authenticated user for a valid token', async () => {
    const user = await requireAuth({ request: bearer(tokenFor(ALICE)), db: makeStore([ALICE]), jwtSecret: SECRET });
    expect(user).toEqual({ id: ALICE.id, name: ALICE.name, email: ALICE.email });
  });
});

describe('requireAdmin', () => {
  it('returns 401 without authentication (not 403)', async () => {
    const request = { headers: {} } as unknown as FastifyRequest;
    await expectAppError(requireAdmin({ request, db: makeStore([ROOT]), jwtSecret: SECRET }), 'UNAUTHORIZED', 401);
  });

  it('returns 403 for an authenticated non-admin user', async () => {
    await expectAppError(
      requireAdmin({ request: bearer(tokenFor(ALICE)), db: makeStore([ALICE]), jwtSecret: SECRET }),
      'FORBIDDEN',
      403,
    );
  });

  it('allows an authenticated admin', async () => {
    const user = await requireAdmin({ request: bearer(tokenFor(ROOT)), db: makeStore([ROOT]), jwtSecret: SECRET });
    expect(user.id).toBe(ROOT.id);
  });

  it('takes the role from the database, not the token: a demoted admin is refused', async () => {
    // Token was issued while ROOT was admin; the stored role is now 'user'.
    const demoted: Row = { ...ROOT, role: 'user' };
    await expectAppError(
      requireAdmin({ request: bearer(tokenFor(ROOT)), db: makeStore([demoted]), jwtSecret: SECRET }),
      'FORBIDDEN',
      403,
    );
  });

  it('refuses a role value other than exactly "admin"', async () => {
    const weird: Row = { ...ALICE, role: 'Admin' };
    await expectAppError(
      requireAdmin({ request: bearer(tokenFor(ALICE)), db: makeStore([weird]), jwtSecret: SECRET }),
      'FORBIDDEN',
      403,
    );
  });
});
