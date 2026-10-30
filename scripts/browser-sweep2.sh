#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "SERVER_READY=$code"

for vp in "1920 1080" "1536 864" "1440 900" "1366 768" "1024 768" "768 1024" "430 932" "375 812" "320 700"; do
  agent-browser set viewport $vp >/dev/null
  agent-browser open http://localhost:3000/ >/dev/null 2>&1
  agent-browser wait 1600 >/dev/null 2>&1
  w=$(echo $vp | cut -d' ' -f1)
  agent-browser screenshot /tmp/v2_home_${w}.png >/dev/null 2>&1
  agent-browser eval "(() => {
    const cta = [...document.querySelectorAll('a')].find(a => a.textContent.trim().startsWith('Shop Now'));
    const r = cta ? cta.getBoundingClientRect() : null;
    const hero = cta ? (cta.closest('[class*=aspect]') || cta.closest('div[class*=min-h]')) : null;
    const hr = hero ? hero.getBoundingClientRect() : null;
    return JSON.stringify({vp: '$vp', ctaFound: !!r, ctaInsideHero: !!(r && hr && r.top >= hr.top - 1 && r.bottom <= hr.bottom + 1), heroH: hr ? Math.round(hr.height) : null, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth});
  })()"
done
