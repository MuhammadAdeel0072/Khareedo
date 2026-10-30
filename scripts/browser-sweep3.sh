#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "SERVER_READY=$code"

echo "=== HOME OVERFLOW SWEEP ==="
for vp in "1920 1080" "1440 900" "1024 768" "768 1024" "430 932" "375 812" "320 700"; do
  agent-browser set viewport $vp >/dev/null
  agent-browser open http://localhost:3000/ >/dev/null 2>&1
  agent-browser wait 1500 >/dev/null 2>&1
  w=$(echo $vp | cut -d' ' -f1)
  agent-browser screenshot /tmp/v3_home_${w}.png >/dev/null 2>&1
  ov=$(agent-browser eval "document.documentElement.scrollWidth - document.documentElement.clientWidth" 2>/dev/null)
  echo "home ${vp} overflow=${ov}"
done

echo "=== INNER PAGES OVERFLOW (320 & 375) ==="
for vp in "320 700" "375 812"; do
  agent-browser set viewport $vp >/dev/null
  for p in "/products" "/products?category=watches" "/categories" "/cart" "/login" "/register" "/contact"; do
    agent-browser open "http://localhost:3000$p" >/dev/null 2>&1
    agent-browser wait 1200 >/dev/null 2>&1
    ov=$(agent-browser eval "document.documentElement.scrollWidth - document.documentElement.clientWidth" 2>/dev/null)
    echo "$vp $p overflow=$ov"
  done
done

echo "=== PDP (product page) ==="
agent-browser set viewport 375 812 >/dev/null
agent-browser open "http://localhost:3000/products/casio-mens-analog-watch" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "document.documentElement.scrollWidth - document.documentElement.clientWidth"
agent-browser screenshot /tmp/v3_pdp_375.png >/dev/null 2>&1
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')]; const atc=b.find(x=>/add to cart/i.test(x.textContent)); const bn=b.find(x=>/^buy now$/i.test(x.textContent.trim())); return JSON.stringify({atc: !!atc, buyNow: !!bn}); })()"
