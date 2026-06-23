#!/usr/bin/env bash
# Manual cron driver for V3 smoke test C (claim-lock / no double-pay).
# You are the clock — this replaces the scheduled job that only runs on Vercel.
#
#   ./scripts/test-cron.sh once      # fire the endpoint once
#   ./scripts/test-cron.sh race      # C2: two parallel fires — exactly one must do real work
#   ./scripts/test-cron.sh c1        # C1: fire once a minute, 3 times (watch for 1 send/cycle)
#
# Reads CRON_SECRET from .env.local so the secret never lands in shell history.

set -euo pipefail
cd "$(dirname "$0")/.."

URL="${CRON_URL:-http://localhost:3000/api/cron/agent-policies}"
SECRET="$(grep -E '^CRON_SECRET=' .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
[ -n "$SECRET" ] || { echo "CRON_SECRET not found in .env.local"; exit 1; }

fire() { curl -s -H "Authorization: Bearer $SECRET" "$URL"; }

case "${1:-once}" in
  once)
    fire | jq '{processed, fired, paused, retried, errors, details}' 2>/dev/null || fire
    ;;
  race)
    echo "Firing two in parallel — expect ONE 'fired', the other 'Already claimed this cycle (idempotent skip)'"
    fire > /tmp/cron_a.json & A=$!
    fire > /tmp/cron_b.json & B=$!
    wait $A $B
    echo "--- A ---"; cat /tmp/cron_a.json | jq '.details' 2>/dev/null || cat /tmp/cron_a.json
    echo "--- B ---"; cat /tmp/cron_b.json | jq '.details' 2>/dev/null || cat /tmp/cron_b.json
    ;;
  c1)
    for i in 1 2 3; do
      echo "=== tick $i ($(date +%H:%M:%S)) ==="
      fire | jq -c '{fired, processed, details}' 2>/dev/null || fire
      [ "$i" -lt 3 ] && sleep 60
    done
    ;;
  *) echo "usage: $0 {once|race|c1}"; exit 1 ;;
esac
