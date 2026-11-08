#!/usr/bin/env bash
# Start the Khareedo production server so the platform preview stays up.
# The ( cmd & ) double-fork orphans the process to init — required, otherwise
# the sandbox reaps direct children of the agent shell between tool calls.
# Resolve the repository root from this script's own location (no sandbox-
# specific paths), then serve the production build with runtime .env loaded.
cd "$(dirname "$0")/.." || exit 1
if [ ! -d .next ]; then
  echo "no production build found — run 'npm run build' first" >&2
  exit 1
fi
if curl -s -o /dev/null --max-time 2 http://localhost:3000/; then
  echo "already running"
  exit 0
fi
( nohup npx next start -p 3000 > dev.log 2>&1 & )
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/ && break; sleep 1; done
curl -s -o /dev/null -w "server=%{http_code}\n" http://localhost:3000/
