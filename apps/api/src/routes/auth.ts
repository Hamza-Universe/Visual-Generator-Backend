import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { passwordResetTokens, users } from '@app/db';
import type { Database } from '@app/db';
import { AppError, sendError } from '../errors.js';
import { AuthService, isValidEmail, verifyToken } from '../services/auth.js';
import type { EmailService } from '../services/email.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      name: string;
    };
  }
}

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email(),
  password: z.string().min(12),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const sanitizeUser = (user: { id: string; name: string; email: string }) => ({
  id: user.id,
  name: user.name,
  email: user.email,
});

export const requireAuth = async ({
  request,
  db,
  jwtSecret,
}: {
  request: FastifyRequest;
  db: Database;
  jwtSecret: string;
}) => {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== 'string' ||
    !authorization.startsWith('Bearer ')
  ) {
    throw new AppError('UNAUTHORIZED', 'Authentication required', 401);
  }

  const token = authorization.slice('Bearer '.length).trim();
  const payload = verifyToken(token, jwtSecret);
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub));

  if (!user) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired token', 401);
  }

  return sanitizeUser({ id: user.id, name: user.name, email: user.email });
};

/**
 * Administrative authorization foundation. Requires an authenticated user whose
 * `role` is 'admin'. Non-admins receive 403 (not 404) so the guard is explicit.
 * The role is read from the database on every call, never from the token.
 */
export const requireAdmin = async ({
  request,
  db,
  jwtSecret,
}: {
  request: FastifyRequest;
  db: Database;
  jwtSecret: string;
}) => {
  const user = await requireAuth({ request, db, jwtSecret });
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id));
  if (!row || row.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Administrator access required', 403);
  }
  return user;
};

export const registerAuthRoutes = (
  app: FastifyInstance,
  db: Database,
  auth: AuthService,
  mailer: EmailService,
) => {
  app.post('/auth/register', async (request, reply) => {
    try {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          'BAD_INPUT',
          'Invalid registration payload',
          400,
          parsed.error.issues,
        );
      }

      const body = parsed.data;
      if (!isValidEmail(body.email)) {
        throw new AppError('BAD_INPUT', 'Invalid email address', 400);
      }

      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.email, body.email.toLowerCase()));
      if (existing) {
        throw new AppError(
          'EMAIL_TAKEN',
          'An account with this email already exists',
          409,
        );
      }

      const user = await auth.registerUser({
        name: body.name,
        email: body.email,
        password: body.password,
      });

      const [created] = await db
        .insert(users)
        .values({
          name: user.name,
          email: user.email,
          passwordHash: user.passwordHash,
        })
        .returning({ id: users.id, name: users.name, email: users.email });

      const token = auth.issueToken({
        id: created.id,
        name: created.name,
        email: created.email,
      });
      return reply.code(201).send({ user: sanitizeUser(created), token });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/auth/login', async (request, reply) => {
    try {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          'BAD_INPUT',
          'Invalid login payload',
          400,
          parsed.error.issues,
        );
      }

      const email = parsed.data.email.trim().toLowerCase();
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email));
      if (!user) {
        throw new AppError('UNAUTHORIZED', 'Invalid email or password', 401);
      }

      const valid = await auth.verifyPassword(
        parsed.data.password,
        user.passwordHash,
      );
      if (!valid) {
        throw new AppError('UNAUTHORIZED', 'Invalid email or password', 401);
      }

      const token = auth.issueToken({
        id: user.id,
        name: user.name,
        email: user.email,
      });
      await db
        .update(users)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, user.id));
      return reply.send({ user: sanitizeUser(user), token });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/auth/forgot-password', async (request, reply) => {
    try {
      const parsed = z
        .object({ email: z.string().trim().email() })
        .safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          'BAD_INPUT',
          'Invalid email address',
          400,
          parsed.error.issues,
        );
      }

      const email = parsed.data.email.trim().toLowerCase();
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email));
      if (!user) {
        return reply.send({
          ok: true,
          message: 'If this account exists, a password reset link was created.',
        });
      }

      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, user.id));
      const reset = auth.createPasswordResetToken(user.id);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      // Persist the token FIRST, then attempt email delivery.
      // This ensures a usable token exists even if email delivery fails.
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: reset.hash,
        expiresAt,
      });

      try {
        await mailer.sendPasswordReset({ to: user.email, token: reset.token });
      } catch (err) {
        request.log.error({ err }, 'Password reset email delivery failed');
        // Token is already persisted; generic response to avoid account enumeration.
      }

      return reply.send({
        ok: true,
        message: 'If this account exists, a password reset link was created.',
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/auth/reset-password', async (request, reply) => {
    try {
      const parsed = z
        .object({ token: z.string().min(16), password: z.string().min(12) })
        .safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          'BAD_INPUT',
          'Invalid reset payload',
          400,
          parsed.error.issues,
        );
      }

      const rows = await db.select().from(passwordResetTokens);
      const candidate = rows.find(
        (row) =>
          !row.usedAt &&
          row.expiresAt > new Date() &&
          auth.verifyPasswordResetToken(parsed.data.token, row.tokenHash),
      );
      if (!candidate) {
        throw new AppError(
          'INVALID_TOKEN',
          'Password reset token is invalid or expired',
          400,
        );
      }

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, candidate.userId));
      if (!user) {
        throw new AppError(
          'INVALID_TOKEN',
          'Password reset token is invalid or expired',
          400,
        );
      }

      const nextPasswordHash = auth.hashPassword(parsed.data.password);

      await db
        .update(users)
        .set({ passwordHash: nextPasswordHash, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date(), updatedAt: new Date() })
        .where(eq(passwordResetTokens.id, candidate.id));
      return reply.send({
        ok: true,
        message: 'Password was reset successfully.',
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/auth/me', async (request, reply) => {
    try {
      const user = await requireAuth({
        request,
        db,
        jwtSecret: auth.getJwtSecret(),
      });
      request.user = user;
      return reply.send({ user });
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
