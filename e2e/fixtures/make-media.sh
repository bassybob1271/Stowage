#!/bin/sh
# Generates media fixtures with ffmpeg inside a throwaway Alpine container.
#   sh e2e/fixtures/make-media.sh
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/out" -w /out alpine:3.22 sh -c '
  apk add --no-cache ffmpeg >/dev/null &&
  ffmpeg -v error -y -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 \
    -t 12 -c:v libx264 -pix_fmt yuv420p -g 25 -c:a aac -movflags +faststart video.mp4 &&
  ffmpeg -v error -y -f lavfi -i testsrc2=size=512x512 -frames:v 1 cover.png &&
  ffmpeg -v error -y -f lavfi -i "sine=frequency=330:sample_rate=44100" -i cover.png -t 20 \
    -map 0:a -map 1:v -c:a libmp3lame -b:a 128k -c:v mjpeg -disposition:v attached_pic \
    -metadata title="Stowage Tone" -metadata artist="Fixture" audio.mp3 &&
  ffmpeg -v error -y -f lavfi -i "sine=frequency=550:sample_rate=44100" -t 8 -c:a libmp3lame -b:a 96k audio2.mp3 &&
  ffmpeg -v error -y -f lavfi -i testsrc2=size=1600x1200 -frames:v 1 -q:v 3 photo.jpg &&
  rm cover.png'
ls -la
