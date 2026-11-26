#!/bin/bash
# Save a Backblaze B2 application key for BazzyBox and Bazzy Live, after checking it with Backblaze.
#   bash ~/Stowage/deploy/mac-mini/set-b2-key.sh
set -u
cd "$(dirname "$0")/../.."
echo "Backblaze → Application Keys → Add a New Application Key (All buckets, Read and Write)."
read -r -p "Paste the keyID, then press Return: " ID </dev/tty
read -r -s -p "Paste the applicationKey (hidden), then press Return: " KEY </dev/tty; echo
ID=$(printf '%s' "$ID" | tr -d ' "\r\n'); KEY=$(printf '%s' "$KEY" | tr -d ' "\r\n')
[ -n "$ID" ] && [ -n "$KEY" ] || { echo "❌ One of them was empty. Nothing was saved."; exit 1; }
if ! curl -s -u "$ID:$KEY" https://api.backblazeb2.com/b2api/v3/b2_authorize_account | grep -q accountId; then
  echo "❌ Backblaze rejected this keyID + applicationKey. Nothing was saved. Check they come from the same key, in that order."
  exit 1
fi
set_var() { # file, name, value
  if grep -q "^$2=" "$1"; then
    awk -v n="$2" -v v="$3" 'BEGIN{FS=OFS="="} $1==n {print n "=" v; next} {print}' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
  else printf '%s=%s\n' "$2" "$3" >> "$1"; fi
  chmod 600 "$1"
}
set_var .env BOX_B2_KEY_ID "$ID";            set_var .env BOX_B2_APP_KEY "$KEY"
set_var apps/live/.env LIVE_B2_KEY_ID "$ID"; set_var apps/live/.env LIVE_B2_APP_KEY "$KEY"
launchctl kickstart -k "gui/$(id -u)/io.bazzy.stack"
echo "✅ Key works. Saved for BazzyBox and Bazzy Live and restarted. Reload box.bazzy.io in ~10 seconds."
