#!/bin/bash
# Production-server e2e: build once, next start, run playwright — all in one call
cd /home/z/my-project

# kill any dev server on :3000
pkill -f "next dev" 2>/dev/null; pkill -f "next-server" 2>/dev/null; sleep 2

echo "=== BUILD ==="
npx next build > /tmp/build.log 2>&1
BUILD=$?
echo "BUILD_EXIT=$BUILD"
[ $BUILD -ne 0 ] && { tail -20 /tmp/build.log; exit 1; }

echo "=== START PROD ==="
setsid nohup npx next start -p 3000 > /tmp/prod.log 2>&1 < /dev/null & disown
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "PROD_SERVER=$code"

echo "=== E2E ==="
npx playwright test --reporter=line > /tmp/e2e5.log 2>&1
echo "E2E_EXIT=$?"
grep -E "passed|failed|flaky|skipped" /tmp/e2e5.log | tail -3
