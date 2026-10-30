#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "SERVER=$code"

echo "=== Forbidden message direct probe ==="
agent-browser set viewport 1280 900 >/dev/null
agent-browser open "http://localhost:3000/admin/login?error=Forbidden" >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
agent-browser eval "JSON.stringify({text: document.body.textContent.includes('does not have administrator access'), errBox: document.body.textContent.match(/This account[^\"]{0,60}/)?.[0]})"

echo "=== Pre-warm admin routes (compile cache) ==="
for p in "/admin/products" "/admin/inventory" "/admin/orders?status=PENDING" "/admin/reports"; do
  c=$(curl -s -o /dev/null -w "%{http_code}" -L "http://localhost:3000$p")
  echo "$p -> $c"
done

echo "=== FULL E2E RUN ==="
npx playwright test --reporter=line > /tmp/e2e4.log 2>&1
echo "EXIT=$?"
grep -E "passed|failed|flaky|skipped" /tmp/e2e4.log | tail -3
