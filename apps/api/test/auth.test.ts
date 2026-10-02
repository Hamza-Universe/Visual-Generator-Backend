import { describe, expect, it } from 'vitest';
import {
  AuthService,
  isValidEmail,
  verifyToken,
} from '../src/services/auth.js';

describe('AuthService', () => {
  it('hashes and validates a password', async () => {
    const service = new AuthService({
      jwtSecret: 'test-secret',
      tokenTtlSeconds: 3600,
      passwordMinLength: 12,
    });

    const user = await service.registerUser({
      name: 'Alice Example',
      email: 'alice@example.com',
      password: 'StrongPass!123',
    });

    expect(user.email).toBe('alice@example.com');
    expect(user.passwordHash).not.toBe('StrongPass!123');
    expect(
      await service.verifyPassword('StrongPass!123', user.passwordHash),
    ).toBe(true);
    expect(
      await service.verifyPassword('WrongPass!123', user.passwordHash),
    ).toBe(false);
  });

  it('issues a valid token and verifies it', async () => {
    const service = new AuthService({
      jwtSecret: 'test-secret',
      tokenTtlSeconds: 3600,
      passwordMinLength: 12,
    });

    const token = service.issueToken({
      id: 'user-1',
      email: 'bob@example.com',
      name: 'Bob',
    });
    const payload = verifyToken(token, 'test-secret');

    expect(payload.sub).toBe('user-1');
    expect(payload.email).toBe('bob@example.com');
    expect(payload.name).toBe('Bob');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('validates email addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  it('creates and validates a password reset token', () => {
    const service = new AuthService({
      jwtSecret: 'test-secret',
      tokenTtlSeconds: 3600,
      passwordMinLength: 12,
    });

    const result = service.createPasswordResetToken('user-42');
    expect(result.token.length).toBeGreaterThan(20);
    expect(service.verifyPasswordResetToken(result.token, result.hash)).toBe(
      true,
    );
    expect(
      service.verifyPasswordResetToken('totally-wrong-token', result.hash),
    ).toBe(false);
  });

  it('rejects malformed JWT signatures without leaking a low-level comparison error', () => {
    expect(() => verifyToken('a.b.c', 'test-secret')).toThrow(
      'Invalid token header',
    );
  });
});
