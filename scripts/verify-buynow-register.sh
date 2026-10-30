#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "SERVER_READY=$code"

echo "=== PDP (singular path) ==="
agent-browser set viewport 375 812 >/dev/null
agent-browser open "http://localhost:3000/product/casio-mens-analog-watch" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({url: location.pathname, title: document.title.slice(0,50), buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t && /cart|buy/i.test(t)).slice(0,5)})"
agent-browser screenshot /tmp/v3_pdp_buy.png >/dev/null 2>&1

echo "=== Buy Now click flow ==="
agent-browser find text "Buy Now" click >/dev/null 2>&1 || agent-browser eval "[...document.querySelectorAll('button')].find(b=>/buy now/i.test(b.textContent))?.click()" >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
agent-browser eval "JSON.stringify({landedAt: location.pathname, hasCheckoutForm: !!document.querySelector('form'), h1: document.querySelector('h1')?.textContent?.slice(0,40)})"

echo "=== Registration flow (signIn fix) ==="
TS=$(date +%s)
agent-browser open "http://localhost:3000/register" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser snapshot -i 2>/dev/null | grep -E "textbox|button" | head -6
