# Stowage Live: native adaptive-bitrate streaming

Send a show from OBS or GStreamer; viewers get an **adaptive bitrate ladder** (1080p / 720p / 480p / 360p HLS) that switches with their connection. Everything runs natively on the Mac, with no Docker. Publicly it's served through Cloudflare Tunnel at `https://live.<your-domain>`.

```
OBS / GStreamer ──RTMP/SRT/WHIP──▶ MediaMTX (ingest, auth)
                                     │ rtsp://127.0.0.1:8554 (local only)
                                     ▼
                                   FFmpeg: decode once → split/scale → H.264 (VideoToolbox) × N + AAC
                                     │ multi-variant HLS, 2 s keyframe-aligned segments
                                     ▼
                     apps/live (Hono): /hls, player with quality picker, /api/streams
                                     │ 127.0.0.1:8790
                                     ▼
                     cloudflared ──▶ https://live.bazzy.io
```

## Setup

```bash
pnpm --filter @stowage/live fetch-bins     # MediaMTX, FFmpeg/ffprobe, cloudflared → apps/live/bin (checksummed)
cp apps/live/.env.example apps/live/.env   # set LIVE_PUBLISH_PASS (openssl rand -hex 16)
sh apps/live/scripts/run-native.sh         # live service + tunnel, auto-restart
```

FFmpeg comes from evermeet.cx, the macOS build linked from ffmpeg.org. It is x86_64 and runs through Rosetta; the hardware H.264 encoder (VideoToolbox) still works. A 1080p source with four rungs uses about half of one CPU core.

## Going live from OBS

Settings → Stream → **Custom**:

| Field | Value |
|---|---|
| Server | `rtmp://127.0.0.1:1935/live` |
| Stream key | `<name>?user=publisher&pass=<LIVE_PUBLISH_PASS>` |

Output: H.264, 2 s keyframe interval, 6–8 Mbps for 1080p30, AAC 160 kbps.

Other inputs:
- **SRT:** `srt://127.0.0.1:8890?streamid=publish:live/<name>:publisher:<pass>`
- **WHIP** (OBS 30+, GStreamer `whipclientsink`): `http://127.0.0.1:8889/live/<name>/whip`, Bearer token `publisher:<pass>`

The stream appears at `https://live.bazzy.io/watch/live-<name>` within about 4 s and on the index page.

Ingest listens on `127.0.0.1` by default. To publish from another machine on your LAN, set `LIVE_INGEST_HOST=0.0.0.0`, which opens those ports on the network, so allow it in the macOS firewall when asked. Cloudflare Tunnel carries viewers' HTTP, not RTMP/SRT/WebRTC ingest.

## Configuration (`apps/live/.env`)

| Variable | Default | |
|---|---|---|
| `LIVE_PUBLISH_PASS` | — required | publisher password (≥ 12 chars) |
| `LIVE_PUBLISH_USER` | `publisher` | |
| `LIVE_LADDER` | `1080,720,480,360` | rung heights; never upscales past the source |
| `LIVE_ENCODER` | `auto` | `videotoolbox` (hardware) or `x264` |
| `LIVE_SEGMENT_SEC` | `2` | segment length (latency ≈ 3 segments) |
| `LIVE_INGEST_HOST` | `127.0.0.1` | `0.0.0.0` for LAN publishers |
| `LIVE_PORT` | `8790` | HTTP for the tunnel |
| `LIVE_PUBLIC_URL`, `LIVE_TITLE` | | shown in the UI |

## Notes

- **Bitrates per rung** at 30 fps: 1080p 5 Mbps, 720p 2.8 Mbps, 480p 1.4 Mbps, 360p 0.8 Mbps. Above 30 fps they are ×1.5.
- **Latency** is about 6–8 s (standard HLS). That's fine for concerts; for two-way interaction use WebRTC (LiveKit), which needs open UDP ports.
- **Cloudflare terms.** Cloudflare's self-serve plans restrict serving video through their CDN outside Cloudflare Stream. A small or personal audience over a tunnel is common, but large public audiences may need Cloudflare Stream or another CDN.
