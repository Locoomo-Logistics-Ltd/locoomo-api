#!/usr/bin/env bash
# Local development: expose the API on a free Cloudflare quick tunnel
# (https://*.trycloudflare.com — no account needed) and point the Sendii
# *sandbox* webhook at it, so real Sendii events reach your machine.
#
#   npm run sendii:tunnel        # then restart the API when it says so
#
# Quick-tunnel URLs change on every start, so this re-registers each time:
# stale tunnel endpoints are removed at Sendii first (max 5 per
# environment), the new signing secret is written to .env, and the endpoint
# is deleted again when you stop it (Ctrl-C). Requires cloudflared
# (https://github.com/cloudflare/cloudflared/releases).
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3000}"

command -v cloudflared >/dev/null || {
  echo "cloudflared not found — install it from https://github.com/cloudflare/cloudflared/releases" >&2
  exit 1
}
# Never point a live Sendii account at a laptop.
grep -q '^SENDII_API_KEY=sk_test_' .env || {
  echo "SENDII_API_KEY in .env must be a sandbox (sk_test_…) key" >&2
  exit 1
}
curl -sf -o /dev/null "http://localhost:${PORT}/health" || {
  echo "Start the API first (npm run start:dev) — nothing on port ${PORT}" >&2
  exit 1
}

LOG="$(mktemp)"
cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}" >"$LOG" 2>&1 &
TUNNEL_PID=$!
ENDPOINT_ID=""

cleanup() {
  if [ -n "$ENDPOINT_ID" ]; then
    npm run -s sendii:webhook -- delete "$ENDPOINT_ID" >/dev/null 2>&1 &&
      echo "Removed Sendii webhook endpoint $ENDPOINT_ID"
  fi
  kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "Tunnel didn't come up:" >&2; cat "$LOG" >&2; exit 1; }
echo "Tunnel: $URL → http://localhost:${PORT}"

# Drop endpoints left behind by earlier tunnels.
npm run -s sendii:webhook -- list | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    for (const e of JSON.parse(raw)) {
      if (/\.trycloudflare\.com\//.test(e.url)) console.log(e.id);
    }
  });' | while read -r stale; do
  npm run -s sendii:webhook -- delete "$stale" >/dev/null && echo "Removed stale endpoint $stale"
done

OUT="$(npm run -s sendii:webhook -- register "$URL")"
ENDPOINT_ID="$(echo "$OUT" | grep -oE 'id [0-9a-f-]+' | cut -d' ' -f2)"
SECRET_LINE="$(echo "$OUT" | grep '^SENDII_WEBHOOK_SECRET=whsec_')"
sed -i '/^SENDII_WEBHOOK_SECRET=/d' .env
printf '%s\n' "$SECRET_LINE" >> .env
echo "Registered endpoint $ENDPOINT_ID; SENDII_WEBHOOK_SECRET updated in .env."
echo "Restart the API so it picks up the new secret, then e.g.:"
echo "  npm run sendii:webhook -- test $ENDPOINT_ID"
echo "Ctrl-C to stop the tunnel and remove the endpoint."

wait "$TUNNEL_PID"
