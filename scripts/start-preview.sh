#!/usr/bin/env bash
# Start the Khareedo production server so the platform preview stays up.
# The ( cmd & ) double-fork orphans the process to init — required, otherwise
# the sandbox reaps direct children of the agent shell between tool calls.
cd /home/z/my-project
if curl -s -o /dev/null --max-time 2 http://localhost:3000/; then
  echo "already running"
  exit 0
fi
( nohup npx next start -p 3000 > dev.log 2>&1 & )
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/ && break; sleep 1; done
curl -s -o /dev/null -w "server=%{http_code}\n" http://localhost:3000/
