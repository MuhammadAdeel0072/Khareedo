#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done

TS=$(date +%s)
EMAIL="qa.tester.${TS}@example.com"
agent-browser set viewport 1280 900 >/dev/null
agent-browser open "http://localhost:3000/register" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser fill @e415 "QA Tester" >/dev/null 2>&1
agent-browser fill @e416 "$EMAIL" >/dev/null 2>&1
agent-browser fill @e417 "TestPass123" >/dev/null 2>&1
agent-browser find text "Create Account" click >/dev/null 2>&1
agent-browser wait 4000 >/dev/null 2>&1
echo "AFTER_REGISTER: $(agent-browser eval "JSON.stringify({url: location.pathname, accountBtn: [...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='Account menu'), toast: document.body.textContent.includes('Account created')})")"

echo "=== Admin guard re-check ==="
curl -s -o /dev/null -w "admin products page (anon): %{http_code} -> %{redirect_url}\n" "http://localhost:3000/admin/products"
curl -s -X POST "http://localhost:3000/api/admin/products" -H "Content-Type: application/json" -d '{"name":"hack","price":1}' -o /dev/null -w "POST /api/admin/products (anon): %{http_code}\n"
curl -s -X PATCH "http://localhost:3000/api/admin/orders/whatever/status" -H "Content-Type: application/json" -d '{"status":"PROCESSING"}' -o /dev/null -w "PATCH order status (anon): %{http_code}\n"
curl -s "http://localhost:3000/api/admin/customers" -o /dev/null -w "GET customers (anon): %{http_code}\n"

echo "=== Checkout API manipulated-request guard (anon, empty cart) ==="
curl -s -X POST "http://localhost:3000/api/checkout" -H "Content-Type: application/json" -d '{"items":[{"productId":"x","quantity":99}],"total":1}' -o /dev/null -w "POST /api/checkout bogus: %{http_code}\n"
