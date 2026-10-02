import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthTokenPayload = {
  sub: string;
  email: string;
  name: string;
  iat: number;
  exp: number;
};

export const isValidEmail = (value: string): boolean => {
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value).toString('base64url');
const base64UrlDecode = (value: string): string =>
  Buffer.from(value, 'base64url').toString('utf8');

export class AuthService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly minLength: number;
  private readonly iterations: number;
  private readonly saltLength: number;

  constructor(config: {
    jwtSecret: string;
    tokenTtlSeconds: number;
    passwordMinLength: number;
    iterations?: number;
    saltLength?: number;
  }) {
    this.secret = config.jwtSecret;
    this.ttlSeconds = config.tokenTtlSeconds;
    this.minLength = config.passwordMinLength;
    this.iterations = config.iterations ?? 200_000;
    this.saltLength = config.saltLength ?? 16;
  }

  public getJwtSecret(): string {
    return this.secret;
  }

  public createPasswordResetToken(_userId: string): {
    token: string;
    hash: string;
  } {
    const token = randomBytes(32).toString('hex');
    return {
      token,
      hash: createHmac('sha256', this.secret).update(token).digest('hex'),
    };
  }

  public hashPasswordResetToken(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('hex');
  }

  public verifyPasswordResetToken(token: string, hash: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const candidate = Buffer.from(this.hashPasswordResetToken(token), 'hex');
    return (
      expected.length === candidate.length &&
      timingSafeEqual(expected, candidate)
    );
  }

  public registerUser(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<{
    id: string;
    name: string;
    email: string;
    passwordHash: string;
  }> {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (name.length < 2)
      throw new Error('Name must be at least 2 characters long');
    if (!isValidEmail(email)) throw new Error('Invalid email address');
    if (input.password.length < this.minLength)
      throw new Error(
        `Password must be at least ${this.minLength} characters long`,
      );

    const id = `user_${randomBytes(12).toString('hex')}`;
    return Promise.resolve({
      id,
      name,
      email,
      passwordHash: this.hashPassword(input.password),
    });
  }

  public hashPassword(password: string): string {
    const salt = randomBytes(this.saltLength).toString('hex');
    const hash = pbkdf2Sync(
      password,
      salt,
      this.iterations,
      32,
      'sha256',
    ).toString('hex');
    return `${salt}:${hash}`;
  }

  public async verifyPassword(
    password: string,
    hash: string,
  ): Promise<boolean> {
    const [salt, storedHash] = hash.split(':');
    if (!salt || !storedHash) return false;

    const candidate = pbkdf2Sync(
      password,
      salt,
      this.iterations,
      32,
      'sha256',
    ).toString('hex');
    const expected = Buffer.from(storedHash, 'hex');
    const actual = Buffer.from(candidate, 'hex');
    return timingSafeEqual(expected, actual);
  }

  public issueToken(user: AuthUser): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: AuthTokenPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      iat: now,
      exp: now + this.ttlSeconds,
    };

    const header = base64UrlEncode(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    );
    const body = base64UrlEncode(JSON.stringify(payload));
    const signature = createHmac('sha256', this.secret)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  public static verifyToken(token: string, secret: string): AuthTokenPayload {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');

    const [header, payload, signature] = parts;
    try {
      const decodedHeader = JSON.parse(base64UrlDecode(header)) as {
        alg?: unknown;
        typ?: unknown;
      };
      if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT')
        throw new Error('Invalid token header');
    } catch {
      throw new Error('Invalid token header');
    }
    const expected = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const signatureBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (
      signatureBytes.length !== expectedBytes.length ||
      !timingSafeEqual(signatureBytes, expectedBytes)
    ) {
      throw new Error('Token signature mismatch');
    }

    let decodedPayload: Partial<AuthTokenPayload>;
    try {
      decodedPayload = JSON.parse(
        base64UrlDecode(payload),
      ) as Partial<AuthTokenPayload>;
    } catch {
      throw new Error('Invalid token payload');
    }
    const now = Math.floor(Date.now() / 1000);

    if (
      typeof decodedPayload.sub !== 'string' ||
      decodedPayload.sub.length === 0 ||
      typeof decodedPayload.exp !== 'number' ||
      decodedPayload.exp <= now
    ) {
      throw new Error('Token is expired');
    }

    return {
      sub: String(decodedPayload.sub ?? ''),
      email: String(decodedPayload.email ?? ''),
      name: String(decodedPayload.name ?? ''),
      iat: Number(decodedPayload.iat ?? now),
      exp: Number(decodedPayload.exp ?? now),
    };
  }
}

export const verifyToken = (token: string, secret: string): AuthTokenPayload =>
  AuthService.verifyToken(token, secret);
