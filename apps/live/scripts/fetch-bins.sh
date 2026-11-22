#!/bin/sh
# Download native binaries for apps/live into apps/live/bin (gitignored).
#   MediaMTX   — GitHub release, verified against the published checksums.sha256
#   cloudflared — official GitHub release (Cloudflare)
#   FFmpeg/ffprobe — evermeet.cx (the macOS build linked from ffmpeg.org; x86_64, runs via Rosetta)
set -eu
MEDIAMTX=v1.21.4
CLOUDFLARED=2026.11.1
FFMPEG=9.1
ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=amd64
cd "$(dirname "$0")/.."
mkdir -p bin
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# MediaMTX
mkdir "$work/mtx" && cd "$work/mtx"
f="mediamtx_${MEDIAMTX}_darwin_${ARCH}.tar.gz"
curl -fsSLO "https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX/$f"
curl -fsSLO "https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX/checksums.sha256"
grep "[ *]$f\$" checksums.sha256 | shasum -a 256 -c -
tar -xzf "$f" mediamtx && cd - >/dev/null && mv "$work/mtx/mediamtx" bin/

# cloudflared
mkdir "$work/cf" && cd "$work/cf"
curl -fsSLO "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED/cloudflared-darwin-${ARCH}.tgz"
tar -xzf "cloudflared-darwin-${ARCH}.tgz" && cd - >/dev/null && mv "$work/cf/cloudflared" bin/

# FFmpeg + ffprobe
for t in ffmpeg ffprobe; do
  mkdir "$work/$t" && cd "$work/$t"
  curl -fsSL -o "$t.zip" "https://evermeet.cx/ffmpeg/$t-$FFMPEG.zip"
  /usr/bin/unzip -q "$t.zip" "$t" && cd - >/dev/null && mv "$work/$t/$t" bin/
done

chmod +x bin/*
xattr -d com.apple.quarantine bin/* 2>/dev/null || true
for b in mediamtx cloudflared ffmpeg ffprobe; do printf '%-12s ' "$b"; "bin/$b" --version 2>&1 | head -1 || "bin/$b" -version 2>&1 | head -1; done
