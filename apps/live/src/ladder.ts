/** Bitrate ladder + FFmpeg argument builder (pure; unit-tested). */

export interface Rung {
  name: string; // e.g. "720p"
  height: number;
  width: number;
  videoKbps: number;
  audioKbps: number;
}

export interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** Reference bitrates (H.264, 30 fps) per height; scaled ×1.5 above 30 fps. */
const BITRATE: Record<number, number> = { 2160: 14000, 1440: 9000, 1080: 5000, 720: 2800, 540: 1800, 480: 1400, 360: 800, 240: 400, 144: 200 };

function kbpsFor(height: number, fps: number): number {
  const known = Object.keys(BITRATE).map(Number).sort((a, b) => a - b);
  const base = BITRATE[height] ?? Math.round((BITRATE[known.find((h) => h >= height) ?? 2160]! * height) / (known.find((h) => h >= height) ?? 2160));
  return Math.round(fps > 31 ? base * 1.5 : base);
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Pick rungs for a source: every configured height ≤ the source height
 * (never upscale), always at least the lowest rung, widths keep the
 * source aspect ratio.
 */
export function buildLadder(heights: number[], src: SourceInfo): Rung[] {
  const aspect = src.width && src.height ? src.width / src.height : 16 / 9;
  let picked = heights.filter((h) => h <= src.height);
  if (!picked.length) picked = [Math.min(...heights, src.height || heights[heights.length - 1]!)];
  return [...new Set(picked)]
    .sort((a, b) => b - a)
    .map((h, i) => ({
      name: `${h}p`,
      height: even(h),
      width: even(h * aspect),
      videoKbps: kbpsFor(h, src.fps),
      audioKbps: i === 0 ? 160 : h >= 480 ? 128 : 96,
    }));
}

export interface FfmpegPlan {
  args: string[];
  rungs: Rung[];
}

/** One FFmpeg process: decode once, split + scale per rung, encode, write multi-variant HLS. */
export function ffmpegArgs(o: {
  input: string;
  outDir: string;
  rungs: Rung[];
  src: SourceInfo;
  encoder: 'videotoolbox' | 'x264';
  segmentSec: number;
  playlistSegments: number;
}): FfmpegPlan {
  const { rungs, src } = o;
  const fps = Math.min(60, Math.max(1, Math.round(src.fps || 30)));
  const gop = Math.max(1, Math.round(fps * o.segmentSec));
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-rtsp_transport', 'tcp', '-i', o.input];

  if (src.hasVideo) {
    const split = rungs.length > 1 ? `split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')};` : '';
    const scales = rungs
      .map((r, i) => `${rungs.length > 1 ? `[s${i}]` : '[0:v:0]'}scale=w=${r.width}:h=${r.height}:flags=bicubic,format=yuv420p[v${i}]`)
      .join(';');
    args.push('-filter_complex', `${rungs.length > 1 ? '[0:v:0]' : ''}${split}${scales}`);
  }

  rungs.forEach((r, i) => {
    if (src.hasVideo) {
      args.push('-map', `[v${i}]`);
      args.push(`-c:v:${i}`, o.encoder === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264');
      args.push(`-b:v:${i}`, `${r.videoKbps}k`, `-maxrate:v:${i}`, `${Math.round(r.videoKbps * 1.2)}k`, `-bufsize:v:${i}`, `${r.videoKbps * 2}k`);
    }
    if (src.hasAudio) {
      args.push('-map', 'a:0?');
      args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, `${r.audioKbps}k`, `-ac:a:${i}`, '2', `-ar:a:${i}`, '48000');
    }
  });

  if (src.hasVideo) {
    args.push('-r', String(fps), '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
    // Keyframes on segment boundaries so every rung switches cleanly.
    args.push('-force_key_frames', `expr:gte(t,n_forced*${o.segmentSec})`);
    if (o.encoder === 'videotoolbox') args.push('-realtime', '1', '-profile:v', 'high', '-allow_sw', '1');
    else args.push('-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high');
  }

  const streamMap = rungs
    .map((r, i) => [src.hasVideo ? `v:${i}` : '', src.hasAudio ? `a:${i}` : '', `name:${r.name}`].filter(Boolean).join(','))
    .join(' ');

  args.push(
    '-f', 'hls',
    '-hls_time', String(o.segmentSec),
    '-hls_list_size', String(o.playlistSegments),
    '-hls_flags', 'delete_segments+independent_segments+temp_file+program_date_time',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${o.outDir}/%v/seg_%06d.ts`,
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', streamMap,
    `${o.outDir}/%v/index.m3u8`,
  );
  return { args, rungs };
}
