#!/bin/bash
# Create the settings files for BazzyBox (.env + mounts.yaml) and Bazzy Live (apps/live/.env),
# with fresh random secrets. Asks for the Backblaze B2 endpoint and keys. Never overwrites a file.
#   bash deploy/mac-mini/make-env.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
rnd() { openssl rand -hex "${1:-32}"; }
ask() { local v; read -r -p "$1: " v </dev/tty; printf '%s' "$v"; }
secret() { local v; read -r -s -p "$1: " v </dev/tty; echo >/dev/tty; printf '%s' "$v"; }

if [ -f .env ] && [ -f apps/live/.env ] && [ -f mounts.yaml ]; then
  echo "Settings files already exist; nothing to do."; exit 0
fi

echo "Backblaze B2 — from a bucket's page in the B2 console (Endpoint, e.g. s3.us-east-005.backblazeb2.com)"
EP=$(ask "B2 endpoint")
EP=${EP#https://}; EP="https://${EP%/}"
REGION=$(printf '%s' "$EP" | sed -nE 's#https://s3\.([a-z0-9-]+)\.backblazeb2\.com#\1#p')
[ -n "$REGION" ] || REGION=$(ask "B2 region (e.g. us-east-005)")
echo
echo "App keys (B2 console → Application Keys). One key per bucket is safest; press Enter to reuse the previous key."
BOX_ID=$(ask "BazzyBox key ID");      BOX_KEY=$(secret "BazzyBox application key")
LIVE_ID=$(ask "BazzyLive key ID");    LIVE_KEY=$(secret "BazzyLive application key")
[ -n "$LIVE_ID" ] || { LIVE_ID=$BOX_ID; LIVE_KEY=$BOX_KEY; }

if [ ! -f .env ]; then
  cat > .env <<EOF
# BazzyBox (box.bazzy.tv) — made by deploy/mac-mini/make-env.sh
PORT=8787
HOST=127.0.0.1
BAZZYBOX=true
BOX_MOUNT=box
BOX_SIGNUP=open
BOX_FREE_GB=10
ACCESS_CODE=$(rnd 16)
SESSION_SECRET=$(rnd)
MASTER_KEY=$(rnd)
DATABASE_URL=file:./data/stowage.db
MOUNTS_FILE=./mounts.yaml
APP_ORIGIN=https://box.bazzy.tv
COOKIE_SECURE=true
TRUST_PROXY=true
NODE_ENV=production
BAZZY_TV_URL=https://video.bazzy.tv
BAZZY_LIVE_URL=https://live.bazzy.tv
# Sign in with Bazzy TV (fill in once Bazzy TV is online):
# BAZZY_AUTH_URL=https://video.bazzy.tv
BAZZY_CLIENT_ID=bazzybox
BAZZY_CLIENT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
BOX_B2_ENDPOINT=$EP
BOX_B2_REGION=$REGION
BOX_B2_BUCKET=bazzybox
BOX_B2_KEY_ID=$BOX_ID
BOX_B2_APP_KEY=$BOX_KEY
EOF
  chmod 600 .env; echo "wrote .env"
fi

if [ ! -f mounts.yaml ]; then
  cat > mounts.yaml <<'EOF'
mounts:
  - id: box
    label: BazzyBox
    kind: s3
    config:
      endpoint: "${BOX_B2_ENDPOINT}"
      region: "${BOX_B2_REGION}"
      bucket: "${BOX_B2_BUCKET}"
      accessKey: "${BOX_B2_KEY_ID}"
      secretKey: "${BOX_B2_APP_KEY}"
      forcePathStyle: true
EOF
  echo "wrote mounts.yaml"
fi

if [ ! -f apps/live/.env ]; then
  cat > apps/live/.env <<EOF
# Bazzy Live (live.bazzy.io) — made by deploy/mac-mini/make-env.sh
LIVE_PUBLIC_URL=https://live.bazzy.io
LIVE_TITLE=Bazzy Live
LIVE_PUBLISH_USER=publisher
LIVE_PUBLISH_PASS=$(rnd 16)
LIVE_INGEST_HOST=0.0.0.0
LIVE_TV_URL=https://bazzyvideo.com
LIVE_BOX_URL=https://box.bazzy.io
LIVE_SESSION_SECRET=$(rnd)
# Sign in with Bazzy TV (fill in once Bazzy TV is online):
# LIVE_BAZZY_AUTH_URL=https://video.bazzy.tv
LIVE_BAZZY_CLIENT_ID=bazzylive
LIVE_BAZZY_CLIENT_SECRET=
LIVE_RECORD=true
LIVE_B2_ENDPOINT=$EP
LIVE_B2_REGION=$REGION
LIVE_B2_BUCKET=bazzylive
LIVE_B2_KEY_ID=$LIVE_ID
LIVE_B2_APP_KEY=$LIVE_KEY
EOF
  chmod 600 apps/live/.env; echo "wrote apps/live/.env"
fi

echo
echo "Station stream password (OBS, until Studio sign-in is on):"
grep '^LIVE_PUBLISH_PASS=' apps/live/.env | cut -d= -f2
