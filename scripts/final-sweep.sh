#!/bin/bash
cd /home/z/my-project
curl -s -o /dev/null -w "PROD=%{http_code}\n" http://localhost:3000/ || exit 1

echo "=== RESPONSIVE FINAL SWEEP (prod build) ==="
for vp in "1920 1080" "1536 864" "1440 900" "1366 768" "1024 768" "768 1024" "430 932" "375 812" "320 700"; do
  agent-browser set viewport $vp >/dev/null
  agent-browser open http://localhost:3000/ >/dev/null 2>&1
  agent-browser wait 1200 >/dev/null 2>&1
  w=$(echo $vp | cut -d' ' -f1)
  agent-browser screenshot /tmp/final_home_${w}.png >/dev/null 2>&1
  ov=$(agent-browser eval "document.documentElement.scrollWidth - document.documentElement.clientWidth" 2>/dev/null)
  h1count=$(agent-browser eval "document.querySelectorAll('h1').length" 2>/dev/null)
  cta=$(agent-browser eval "(() => { const c=[...document.querySelectorAll('a')].find(a=>a.textContent.trim().startsWith('Shop Now')); if(!c) return 'MISSING'; const hr=c.closest('div[class*=min-h]').getBoundingClientRect(); const r=c.getBoundingClientRect(); return r.top>=hr.top-1&&r.bottom<=hr.bottom+1?'VISIBLE_IN_HERO':'CLIPPED'; })()" 2>/dev/null)
  echo "${vp}: overflow=${ov} h1=${h1count} heroCTA=${cta}"
done

echo "=== KEY ROUTES ==="
for p in "/" "/products" "/categories" "/cart" "/login" "/register" "/contact" "/admin/login" "/product/casio-mens-analog-watch"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000$p")
  echo "$p -> $code"
done

echo "=== CONSOLE ERRORS on homepage ==="
agent-browser set viewport 1440 900 >/dev/null
agent-browser open http://localhost:3000/ >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
agent-browser errors 2>/dev/null | head -5
echo "(end errors)"
