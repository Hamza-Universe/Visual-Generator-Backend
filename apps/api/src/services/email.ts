import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  resetUrl: string;
};

export class EmailService {
  private readonly transporter: Transporter | undefined;

  constructor(
    private readonly config: EmailConfig,
    private readonly sendOverride?: (message: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }) => Promise<void>,
  ) {
    if (config.host && config.from) {
      this.transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user
          ? { user: config.user, pass: config.password }
          : undefined,
      });
    }
  }

  public isConfigured(): boolean {
    return this.transporter !== undefined;
  }

  public async sendPasswordReset(input: {
    to: string;
    token: string;
  }): Promise<void> {
    const resetLink = `${this.config.resetUrl}?token=${encodeURIComponent(input.token)}`;
    const message = {
      from: this.config.from,
      to: input.to,
      subject: 'Reset your password',
      text: `Reset your password using this link: ${resetLink}\n\nThis link expires in one hour and can only be used once.`,
      html: `<p>Reset your password using the link below.</p><p><a href="${resetLink}">Reset password</a></p><p>This link expires in one hour and can only be used once.</p>`,
    };
    if (this.sendOverride) return this.sendOverride(message);
    if (!this.transporter)
      throw new Error('Password reset email is not configured');
    await this.transporter.sendMail(message);
  }
}
