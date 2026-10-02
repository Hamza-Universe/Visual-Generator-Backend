import { describe, expect, it } from 'vitest';
import { EmailService } from '../src/services/email.js';

describe('EmailService', () => {
  it('builds a password reset link containing the raw token', async () => {
    let message: { to: string; text: string; html: string } | undefined;
    const service = new EmailService(
      {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'mailer',
        password: 'secret',
        from: 'no-reply@example.com',
        resetUrl: 'https://frontend.example.com/reset-password',
      },
      async (sent) => {
        message = sent;
      },
    );

    await service.sendPasswordReset({
      to: 'user@example.com',
      token: 'raw-reset-token',
    });

    expect(message?.to).toBe('user@example.com');
    expect(message?.text).toContain(
      'https://frontend.example.com/reset-password?token=raw-reset-token',
    );
    expect(message?.html).toContain('raw-reset-token');
  });
});
