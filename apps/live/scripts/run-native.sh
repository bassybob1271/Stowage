#!/bin/sh
# Run the live service, BazzyBox (optional) and the Cloudflare Tunnel natively, restarting either if it exits.
#   sh apps/live/scripts/run-native.sh        (Ctrl+C stops both)
# Requires: pnpm --filter @stowage/live fetch-bins, apps/live/.env,
#           deploy/cloudflared/native.yml (+ credentials JSON).
set -u
root=$(cd "$(dirname "$0")/../../.." && pwd)
live="$root/apps/live"
export PATH="$HOME/.local/bin:$PATH"

keep() { # name, dir, command...
  name=$1; dir=$2; shift 2
  ( while :; do
      (cd "$dir" && "$@")
      echo "[$name] exited ($?); restarting in 3s" >&2
      sleep 3
    done ) &
}

# The old Live service runs its own RTMP ingest on :1935. Once Bazzy TV's ingest is installed on this Mac
# (tv.bazzy.ingest, from bazzy-tv/apps/live/mediamtx/native/start.sh install), it owns that port, so skip ours.
if [ -f "$HOME/Library/LaunchAgents/tv.bazzy.ingest.plist" ] || [ "${STOWAGE_LIVE:-on}" = off ]; then
  echo "[live] skipped: Bazzy TV's ingest (tv.bazzy.ingest) handles streaming on this Mac" >&2
else
  keep live "$live" node --import ./node_modules/tsx/dist/loader.mjs --env-file=.env src/main.ts
fi
# BazzyBox (box.bazzy.io): run the Stowage server too when the root .env turns it on.
# Build it first: pnpm --filter @stowage/web build && pnpm --filter @stowage/server build
if [ -f "$root/.env" ] && grep -q '^BAZZYBOX=true' "$root/.env"; then
  keep box "$root" node --env-file=.env apps/server/dist/main.js
fi
keep tunnel "$root" "$live/bin/cloudflared" --no-autoupdate tunnel --config deploy/cloudflared/native.yml run

trap 'kill 0' INT TERM
wait
