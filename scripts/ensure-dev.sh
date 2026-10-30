#!/bin/bash
# Ensure dev server is up (start if dead), wait until it responds.
cd /home/z/my-project
if ! curl -s -o /dev/null --max-time 3 http://localhost:3000; then
  setsid nohup npx next dev --port 3000 > dev.log 2>&1 < /dev/null &
  for i in $(seq 1 45); do
    sleep 2
    if curl -s -o /dev/null --max-time 5 http://localhost:3000; then
      echo "server ready (attempt $i)"
      exit 0
    fi
  done
  echo "server failed to start"
  exit 1
fi
echo "server already running"
