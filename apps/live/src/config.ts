import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const optUrl = z.string().url().optional().or(z.literal('').transform(() => undefined));

const schema = z.object({
  LIVE_PORT: z.coerce.number().int().positive().default(8790),
  LIVE_HOST: z.string().default('127.0.0.1'),
  /** Interface MediaMTX listens on for ingest (RTMP/SRT/WHIP). 0.0.0.0 to accept OBS from the LAN. */
  LIVE_INGEST_HOST: z.string().default('127.0.0.1'),
  LIVE_RTMP_PORT: z.coerce.number().int().positive().default(1935),
  LIVE_SRT_PORT: z.coerce.number().int().positive().default(8890),
  LIVE_WHIP_PORT: z.coerce.number().int().positive().default(8889),
  /** Credentials a publisher must present (OBS stream key carries them). */
  LIVE_PUBLISH_USER: z.string().min(1).default('publisher'),
  LIVE_PUBLISH_PASS: z.string().min(12, 'LIVE_PUBLISH_PASS must be at least 12 characters (openssl rand -hex 16)'),
  /** Comma-separated rung heights, highest first. Rungs above the source height are skipped. */
  LIVE_LADDER: z.string().default('1080,720,480,360'),
  /** auto = h264_videotoolbox when available, else libx264. */
  LIVE_ENCODER: z.enum(['auto', 'videotoolbox', 'x264']).default('auto'),
  LIVE_SEGMENT_SEC: z.coerce.number().positive().default(2),
  LIVE_PLAYLIST_SEGMENTS: z.coerce.number().int().positive().default(8),
  LIVE_DATA_DIR: z.string().default('./data'),
  LIVE_BIN_DIR: z.string().default('./bin'),
  /** Public base URL shown in the UI, e.g. https://live.example.com */
  LIVE_PUBLIC_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  LIVE_TITLE: z.string().default('Live'),
  /** BazzyBox storage site linked from the header. Empty hides the link. */
  LIVE_BOX_URL: optUrl.default('https://box.bazzy.io'),
  LIVE_TRUST_PROXY: bool.default('true'),
  /** Bazzy TV video site, linked from the header. Empty hides the link. */
  LIVE_TV_URL: optUrl.default('https://bazzyvideo.com'),

  /* ── Sign in with Bazzy TV (creators get their own stream key) ── */
  /** Bazzy TV website that hosts /oauth/authorize, e.g. https://bazzyvideo.com. Empty turns sign-in off. */
  LIVE_BAZZY_AUTH_URL: optUrl,
  LIVE_BAZZY_CLIENT_ID: z.string().default('bazzylive'),
  LIVE_BAZZY_CLIENT_SECRET: z.string().optional(),
  /** Signs session cookies and encrypts stored stream keys (openssl rand -hex 32). */
  LIVE_SESSION_SECRET: z.string().optional(),
  /** Bazzy TV roles that may go live, comma-separated; * = any signed-in account. */
  LIVE_CREATOR_ROLES: z.string().default('filmmaker,admin'),
  /** RTMP server address shown to creators in the Studio page (OBS "Server"). */
  LIVE_RTMP_PUBLIC_URL: z.string().optional(),

  /* ── Recordings ── */
  /** Record every show (the original feed, not the ladder) for replay. */
  LIVE_RECORD: bool.default('false'),
  /** Longest single recording file; a longer show is split into parts. */
  LIVE_RECORD_SEGMENT: z.string().regex(/^\d+[smh]$/, 'like 1h or 30m').default('1h'),
  /** Keep the local copy after it is uploaded to B2. */
  LIVE_RECORD_KEEP_LOCAL: bool.default('false'),
  /** Backblaze B2 (S3-compatible) bucket for recordings. Leave all empty to keep recordings on this machine. */
  LIVE_B2_ENDPOINT: optUrl,
  LIVE_B2_REGION: z.string().optional(),
  LIVE_B2_BUCKET: z.string().optional(),
  LIVE_B2_KEY_ID: z.string().optional(),
  LIVE_B2_APP_KEY: z.string().optional(),
  LIVE_B2_PREFIX: z.string().default('recordings/'),
});

export type Config = z.infer<typeof schema> & {
  hlsDir: string;
  binDir: string;
  recordDir: string;
  ladder: number[];
  /** Sign in with Bazzy TV is fully configured. */
  bazzy: boolean;
  /** Recordings go to B2 (otherwise they stay in recordDir). */
  b2: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    console.error('Invalid configuration:\n' + r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const ladder = r.data.LIVE_LADDER.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 144 && n <= 4320)
    .sort((a, b) => b - a);
  if (!ladder.length) {
    console.error('LIVE_LADDER must list at least one height, e.g. 1080,720,480,360');
    process.exit(1);
  }
  const d = r.data;
  const fail = (m: string) => {
    console.error(`Invalid configuration:\n  - ${m}`);
    process.exit(1);
  };
  const bazzy = Boolean(d.LIVE_BAZZY_AUTH_URL);
  if (bazzy && !d.LIVE_BAZZY_CLIENT_SECRET) fail('LIVE_BAZZY_CLIENT_SECRET is required when LIVE_BAZZY_AUTH_URL is set');
  if (bazzy && (d.LIVE_SESSION_SECRET ?? '').length < 32) fail('LIVE_SESSION_SECRET must be at least 32 characters when sign-in is on (openssl rand -hex 32)');
  const b2Vars = [d.LIVE_B2_ENDPOINT, d.LIVE_B2_BUCKET, d.LIVE_B2_KEY_ID, d.LIVE_B2_APP_KEY];
  const b2 = b2Vars.every(Boolean);
  if (!b2 && b2Vars.some(Boolean)) fail('set all of LIVE_B2_ENDPOINT, LIVE_B2_BUCKET, LIVE_B2_KEY_ID and LIVE_B2_APP_KEY, or none');
  return {
    ...d,
    ladder,
    bazzy,
    b2,
    hlsDir: resolve(d.LIVE_DATA_DIR, 'hls'),
    recordDir: resolve(d.LIVE_DATA_DIR, 'recordings'),
    binDir: resolve(d.LIVE_BIN_DIR),
  };
}
