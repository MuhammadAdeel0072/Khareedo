#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "SERVER_READY=$code"

agent-browser set viewport 768 1024 >/dev/null
agent-browser open http://localhost:3000/ >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
agent-browser eval "(() => {
  const cw = document.documentElement.clientWidth;
  const bad = [];
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > cw + 4 || r.right > cw + 4) {
      bad.push({tag: el.tagName, cls: (el.className+'').slice(0,90), w: Math.round(r.width), right: Math.round(r.right)});
    }
  });
  return JSON.stringify(bad.slice(0, 12), null, 1);
})()"
