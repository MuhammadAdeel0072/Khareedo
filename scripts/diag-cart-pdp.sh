#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done

agent-browser set viewport 320 700 >/dev/null
agent-browser open "http://localhost:3000/cart" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
echo "=== cart 320 culprits ==="
agent-browser eval "(() => {
  const cw = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > cw + 1 && el.children.length < 3) bad.push({tag: el.tagName, cls: (el.className+'').slice(0,60), right: Math.round(r.right), txt: (el.textContent||'').slice(0,25)});
  });
  return JSON.stringify(bad.slice(0,8));
})()"

agent-browser set viewport 375 812 >/dev/null
agent-browser open "http://localhost:3000/products" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
echo "=== PDP buttons probe ==="
agent-browser find text "Casio" click 2>/dev/null || agent-browser eval "location.href = document.querySelector('a[href*=\\/products\\/]')?.href || '/products'" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({url: location.pathname, buttons: [...document.querySelectorAll('button, a')].map(b => b.textContent.trim()).filter(t => t && t.length < 30 && /cart|buy|now/i.test(t)).slice(0,6)})"
