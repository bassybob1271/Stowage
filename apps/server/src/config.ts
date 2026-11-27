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

  // ---------- BazzyBox (multi-user, plans, credits) ----------
  /** Turn on email/password accounts, per-user storage, plans and the credits wallet. */
  BAZZYBOX: bool.default('false'),
  /** Mount (from mounts.yaml) that holds every user's files, each under u/<id>/. Point it at Backblaze B2. */
  BOX_MOUNT: z.string().default('box'),
  BOX_FREE_GB: z.coerce.number().positive().default(10),
  /** open = anyone can sign up; closed = only existing accounts. */
  BOX_SIGNUP: z.enum(['open', 'closed']).default('open'),
  /** Bazzy TV video site, linked from the BazzyBox website. Empty hides the link. */
  BAZZY_TV_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)).default('https://video.bazzy.tv'),
  /**
   * "Sign in with Bazzy TV": the Bazzy TV website (bazzy-video) is the login provider.
   * Register BazzyBox in Bazzy TV's OAUTH_CLIENTS with redirect URI {APP_ORIGIN}/api/auth/bazzy/callback.
   */
  BAZZY_AUTH_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  BAZZY_CLIENT_ID: z.string().default('bazzybox'),
  BAZZY_CLIENT_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Grant credits without payment (local testing only; refused in production). */
  BOX_DEV_CREDITS: bool.default('false'),
  STRIPE_SECRET_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  STRIPE_WEBHOOK_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * Import from Dropbox. Create an app at dropbox.com/developers (scoped access, Full Dropbox,
   * permissions files.metadata.read + files.content.read) with redirect URI
   * {APP_ORIGIN}/api/box/import/dropbox/callback. Empty hides the Dropbox import button.
   */
  DROPBOX_APP_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  DROPBOX_APP_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Files copied at once across all imports, and how often the import worker looks for work. */
  IMPORT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  IMPORT_INTERVAL_SEC: z.coerce.number().int().nonnegative().default(5),
  /** How often the storage meter and plan renewals run. */
  BOX_METER_INTERVAL_SEC: z.coerce.number().int().nonnegative().default(3600),
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
  if (r.data.BOX_DEV_CREDITS && r.data.NODE_ENV === 'production') {
    console.error('\nInvalid configuration:\n  - BOX_DEV_CREDITS: free credits are refused when NODE_ENV=production\n');
    process.exit(1);
  }
  return r.data;
}
