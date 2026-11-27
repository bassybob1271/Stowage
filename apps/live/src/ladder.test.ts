import { describe, expect, it } from 'vitest';
import { buildLadder, ffmpegArgs } from './ladder.js';
import { mediamtxConfig, slugOf } from './supervisor.js';
import { loadConfig } from './config.js';

const HD = { width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };

describe('buildLadder', () => {
  it('uses every rung at or below the source height', () => {
    expect(buildLadder([1080, 720, 480, 360], HD).map((r) => `${r.width}x${r.height}@${r.videoKbps}`)).toEqual([
      '1920x1080@5000', '1280x720@2800', '854x480@1400', '640x360@800',
    ]);
  });
  it('never upscales', () => {
    expect(buildLadder([1080, 720, 480, 360], { ...HD, width: 1280, height: 720 }).map((r) => r.name)).toEqual(['720p', '480p', '360p']);
  });
  it('keeps one rung for tiny sources', () => {
    expect(buildLadder([1080, 720], { ...HD, width: 320, height: 240 }).map((r) => r.name)).toEqual(['240p']);
  });
  it('keeps aspect ratio with even dimensions (vertical video)', () => {
    const r = buildLadder([720, 360], { ...HD, width: 1080, height: 1920 });
    expect(r.map((x) => `${x.width}x${x.height}`)).toEqual(['406x720', '202x360']);
  });
  it('raises bitrates for 60 fps', () => {
    expect(buildLadder([720], { ...HD, fps: 60 })[0]!.videoKbps).toBe(4200);
  });
});

describe('ffmpegArgs', () => {
  const plan = ffmpegArgs({
    input: 'rtsp://127.0.0.1:8554/live/show',
    outDir: '/tmp/x',
    rungs: buildLadder([1080, 720, 480], HD),
    src: HD,
    encoder: 'videotoolbox',
    segmentSec: 2,
    playlistSegments: 8,
  });
  const a = plan.args.join(' ');
  it('decodes once and splits into each rung', () => {
    expect(a).toContain('[0:v:0]split=3[s0][s1][s2];[s0]scale=w=1920:h=1080');
    expect(a).toContain('[s2]scale=w=854:h=480');
  });
  it('writes a master playlist with one variant per rung', () => {
    expect(a).toContain('-master_pl_name master.m3u8');
    expect(plan.args[plan.args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p');
  });
  it('aligns keyframes to segments and uses the hardware encoder', () => {
    expect(a).toContain('-g 60 -keyint_min 60');
    expect(a).toContain('expr:gte(t,n_forced*2)');
    expect(a).toContain('-c:v:0 h264_videotoolbox');
  });
});

describe('mediamtx config', () => {
  const cfg = loadConfig({ LIVE_PUBLISH_PASS: 'x"y\'z-very-long-pass' } as NodeJS.ProcessEnv);
  const y = mediamtxConfig(cfg, { authUrl: 'http://127.0.0.1:8790/internal/mtx-auth/s"x', record: false });
  it('checks publishers through apps/live and keeps read/API on localhost', () => {
    expect(y).toContain('authHTTPAddress: "http://127.0.0.1:8790/internal/mtx-auth/s\\"x"');
    expect(y).not.toContain('very-long-pass');
    expect(y).toContain('record: no');
    expect(y).toContain('apiAddress: 127.0.0.1:9997');
    expect(y).toContain('rtspAddress: 127.0.0.1:8554');
    expect(y).toContain('hls: no');
  });
  it('slugs paths for URLs', () => expect(slugOf('live/My Show!')).toBe('live-my-show'));
});
