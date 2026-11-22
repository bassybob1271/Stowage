import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

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
  LIVE_TRUST_PROXY: bool.default('true'),
});

export type Config = z.infer<typeof schema> & { hlsDir: string; binDir: string; ladder: number[] };

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
  return { ...r.data, ladder, hlsDir: resolve(r.data.LIVE_DATA_DIR, 'hls'), binDir: resolve(r.data.LIVE_BIN_DIR) };
}
