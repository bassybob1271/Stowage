import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id (a const enum, which verbatimModuleSyntax can't import).
const ARGON2ID = 2;
import type { Context, MiddlewareHandler } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Config } from './config.js';
import { log } from './log.js';

/**
 * Pluggable authentication. The code gate is the only provider today; OIDC or
 * passkeys can implement this interface later without touching routes.
 */
export interface AuthProvider {
  readonly name: string;
  /** Verify a login request body. Return a subject id on success, null on failure. */
  authenticate(body: unknown): Promise<string | null>;
}

/** "Enter access code" gate. The code is hashed with argon2id at boot; plaintext is never stored or sent. */
export class CodeGateProvider implements AuthProvider {
  readonly name = 'code';
  private constructor(private readonly codeHash: string) {}

  static async create(code: string) {
    const h = await hash(code, { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    return new CodeGateProvider(h);
  }

  async authenticate(body: unknown): Promise<string | null> {
    const code = (body as { code?: unknown })?.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > 256) return null;
    // argon2 verify compares digests in constant time.
    return (await verify(this.codeHash, code)) ? 'owner' : null;
  }
}

// ---------- rate limiting ----------

interface Bucket {
  attempts: number[]; // timestamps (ms) of failures in the last minute
  failures: number; // consecutive failures (reset on success)
  lockedUntil: number;
}

/** 5 failures/minute per IP, then exponential backoff (2s, 4s, 8s … capped at 1h). */
export class LoginLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly perMinute = 5, private readonly now = () => Date.now()) {}

  check(ip: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const b = this.buckets.get(ip);
    const t = this.now();
    if (b && b.lockedUntil > t) return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - t) / 1000) };
    return { allowed: true };
  }

  fail(ip: string): number {
    const t = this.now();
    const b = this.buckets.get(ip) ?? { attempts: [], failures: 0, lockedUntil: 0 };
    b.attempts = b.attempts.filter((x) => t - x < 60_000);
    b.attempts.push(t);
    b.failures++;
    if (b.attempts.length >= this.perMinute) {
      const over = b.failures - this.perMinute;
      const delay = Math.min(3600_000, 2000 * 2 ** Math.max(0, over));
      b.lockedUntil = t + delay;
    }
    this.buckets.set(ip, b);
    return b.lockedUntil > t ? Math.ceil((b.lockedUntil - t) / 1000) : 0;
  }

  succeed(ip: string) {
    this.buckets.delete(ip);
  }

  /** Drop stale buckets so memory stays bounded. */
  sweep() {
    const t = this.now();
    for (const [ip, b] of this.buckets) if (b.lockedUntil < t && b.attempts.every((x) => t - x > 60_000)) this.buckets.delete(ip);
  }
}

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Cloudflare sets this itself; clients can't forge it through the edge.
    const cf = c.req.header('cf-connecting-ip');
    if (cf) return cf.trim();
    // Otherwise take the entry our proxy appended (rightmost); leftmost entries are client-supplied.
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',').pop()!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------- sessions ----------

export const SESSION_COOKIE = 'stowage_session';

interface SessionPayload {
  sub: string;
  iat: number; // ms
  exp: number; // ms
}

export class Sessions {
  constructor(private readonly cfg: Config) {}

  private get ttlMs() {
    return this.cfg.SESSION_TTL_DAYS * 86_400_000;
  }

  async issue(c: Context, sub: string) {
    const now = Date.now();
    const payload: SessionPayload = { sub, iat: now, exp: now + this.ttlMs };
    await setSignedCookie(c, SESSION_COOKIE, JSON.stringify(payload), this.cfg.SESSION_SECRET, {
      httpOnly: true,
      secure: this.cfg.COOKIE_SECURE,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(this.ttlMs / 1000),
    });
  }

  async read(c: Context): Promise<SessionPayload | null> {
    const raw = await getSignedCookie(c, this.cfg.SESSION_SECRET, SESSION_COOKIE);
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as SessionPayload;
      return p.exp > Date.now() ? p : null;
    } catch {
      return null;
    }
  }

  clear(c: Context) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: this.cfg.COOKIE_SECURE, httpOnly: true, sameSite: 'Lax' });
  }

  /** Require a valid session; roll the expiry forward at most once an hour. */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const s = await this.read(c);
      if (!s) return c.json({ error: 'unauthorized' }, 401);
      if (Date.now() - s.iat > 3600_000) await this.issue(c, s.sub);
      c.set('user' as never, s.sub as never);
      await next();
    };
  }
}

export function logFailedLogin(ip: string, lockSec: number) {
  log.warn('auth.login_failed', { ip, lockedForSec: lockSec });
}
