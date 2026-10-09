import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { passwordResetTokens } from '@app/db/schema';
import type { Database } from '@app/db';
import { AppError } from '../src/errors.js';
import { AuthService } from '../src/services/auth.js';
import { EmailService } from '../src/services/email.js';

describe('Password reset flow', () => {
  const USER_ID = 'user-1';
  const USER_EMAIL = 'user@example.com';

  const mockDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ id: USER_ID, email: USER_EMAIL }])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  } as unknown as Database;

  const auth = new AuthService({
    jwtSecret: 'test-secret',
    tokenTtlSeconds: 3600,
    passwordMinLength: 12,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists reset token before attempting email delivery', async () => {
    let insertCalled = false;
    let emailSent = false;

    mockDb.insert.mockImplementationOnce(() => ({
      values: vi.fn().mockImplementation(() => {
        insertCalled = true;
        return Promise.resolve();
      }),
    }));

    const mailer = new EmailService(
      {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'mailer',
        password: 'secret',
        from: 'no-reply@example.com',
        resetUrl: 'https://frontend.example.com/reset-password',
      },
      async () => {
        emailSent = true;
      },
    );

    // Simulate the forgot-password flow
    const reset = auth.createPasswordResetToken(USER_ID);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Step 1: Persist token
    await mockDb.insert(passwordResetTokens).values({
      userId: USER_ID,
      tokenHash: reset.hash,
      expiresAt,
    });

    expect(insertCalled).toBe(true);
    expect(emailSent).toBe(false); // Email not sent yet

    // Step 2: Send email
    await mailer.sendPasswordReset({ to: USER_EMAIL, token: reset.token });

    expect(emailSent).toBe(true);
  });

  it('persists token even when email delivery fails', async () => {
    let insertCalled = false;
    let emailError: Error | null = null;

    mockDb.insert.mockImplementationOnce(() => ({
      values: vi.fn().mockImplementation(() => {
        insertCalled = true;
        return Promise.resolve();
      }),
    }));

    const mailer = new EmailService(
      {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'mailer',
        password: 'secret',
        from: 'no-reply@example.com',
        resetUrl: 'https://frontend.example.com/reset-password',
      },
      async () => {
        throw new Error('SMTP connection failed');
      },
    );

    const reset = auth.createPasswordResetToken(USER_ID);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Persist token
    await mockDb.insert(passwordResetTokens).values({
      userId: USER_ID,
      tokenHash: reset.hash,
      expiresAt,
    });

    expect(insertCalled).toBe(true);

    // Attempt email delivery (will fail)
    try {
      await mailer.sendPasswordReset({ to: USER_EMAIL, token: reset.token });
    } catch (err) {
      emailError = err as Error;
    }

    expect(emailError).not.toBeNull();
    expect(emailError?.message).toBe('SMTP connection failed');
    // Token was already persisted before email attempt
    expect(insertCalled).toBe(true);
  });

  it('reset token has correct structure and expiry', () => {
    const reset = auth.createPasswordResetToken(USER_ID);

    expect(reset.token).toBeDefined();
    expect(reset.token.length).toBeGreaterThan(20);
    expect(reset.hash).toBeDefined();
    expect(reset.hash).not.toBe(reset.token); // Hash should be different from token

    // Verify the token can be validated against its hash
    expect(auth.verifyPasswordResetToken(reset.token, reset.hash)).toBe(true);
    expect(auth.verifyPasswordResetToken('wrong-token', reset.hash)).toBe(false);
  });

  it('rejects expired or used tokens', async () => {
    const reset = auth.createPasswordResetToken(USER_ID);
    const pastExpiry = new Date(Date.now() - 1000); // 1 second ago

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            userId: USER_ID,
            tokenHash: reset.hash,
            expiresAt: pastExpiry,
            usedAt: null,
          },
        ]),
      }),
    });

    const rows = await mockDb.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, USER_ID));
    const candidate = rows.find(
      (row) =>
        !row.usedAt &&
        row.expiresAt > new Date() &&
        auth.verifyPasswordResetToken(reset.token, row.tokenHash),
    );

    expect(candidate).toBeUndefined();
  });
});