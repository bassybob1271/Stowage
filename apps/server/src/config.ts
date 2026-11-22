import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('0.0.0.0'),

  ACCESS_CODE: z.string().min(1).default('42'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters (try: openssl rand -hex 32)'),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(7),
  /** Set false only for plain-http local dev on non-localhost hosts. */
  COOKIE_SECURE: bool.default('true'),
  /** Trust X-Forwarded-For for client IPs (only behind your own reverse proxy). */
  TRUST_PROXY: bool.default('false'),

  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'MASTER_KEY must be 32 bytes hex (openssl rand -hex 32)'),
  DATABASE_URL: z.string().default('file:./data/stowage.db'),
  MOUNTS_FILE: z.string().default('./mounts.yaml'),
  DATA_DIR: z.string().default('./data'),

  DIRECT_TRANSFER: bool.default('false'),
  /** e.g. https://content.example.com — a separate origin for serving user content. */
  CONTENT_ORIGIN: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  APP_ORIGIN: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** Max upload size in bytes; 0 = unlimited. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().nonnegative().default(0),
  RECONCILE_INTERVAL_SEC: z.coerce.number().int().nonnegative().default(900),
  /** Paths are relative to the working directory (the repo root in dev). */
  WEB_DIST: z.string().default('./apps/web/dist'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Fail fast with an actionable message.
    console.error(`\nInvalid configuration:\n${lines.join('\n')}\n\nSee deploy/.env.example.\n`);
    process.exit(1);
  }
  return r.data;
}
