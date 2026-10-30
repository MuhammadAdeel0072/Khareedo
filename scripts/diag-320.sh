#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
agent-browser set viewport 320 700 >/dev/null
agent-browser open http://localhost:3000/ >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "(() => {
  const cw = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > cw + 2 && el.children.length < 3) {
      bad.push({tag: el.tagName, cls: (el.className+'').slice(0,70), w: Math.round(r.width), right: Math.round(r.right), txt: (el.textContent||'').slice(0,30)});
    }
  });
  return JSON.stringify({cw, bad: bad.slice(0,10)}, null, 1);
})()"
