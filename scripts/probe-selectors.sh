#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done

agent-browser set viewport 1280 900 >/dev/null

echo "=== customer login ==="
agent-browser open "http://localhost:3000/login" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const em=i.find(x=>x.type==='email'||/email/i.test(x.id)); const pw=i.find(x=>x.type==='password'); const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(em,'ali.hassan@example.com'); set(pw,'Customer@123'); return 'ok'; })()" >/dev/null 2>&1
agent-browser eval "document.querySelector('form')?.requestSubmit()" >/dev/null 2>&1
agent-browser wait 3500 >/dev/null 2>&1
echo "after login: $(agent-browser eval "location.pathname")"

echo "=== /account/orders refs ==="
agent-browser open "http://localhost:3000/account/orders" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({h1: document.querySelector('h1')?.textContent, refSamples: [...document.querySelectorAll('a,td,span,div')].map(e=>e.textContent?.trim()).filter(t=>/^KH\\d+/.test(t||'')).slice(0,4), empty: document.body.textContent.slice(0,300).match(/no orders|empty/i)?.[0]})"

echo "=== /checkout step1 labels ==="
TS=$(date +%s)
agent-browser open "http://localhost:3000/product/soundpeats-q3-pro-anc" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "[...document.querySelectorAll('button')].find(b=>/add to cart/i.test(b.textContent))?.click()" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser open "http://localhost:3000/checkout" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({labels: [...document.querySelectorAll('label')].map(l=>l.textContent.trim()).slice(0,10), buttons: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,8), url: location.pathname})"

echo "=== /admin/orders row structure ==="
agent-browser open "http://localhost:3000/admin/login" >/dev/null 2>&1
agent-browser wait 1200 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const em=i.find(x=>x.type==='email'); const pw=i.find(x=>x.type==='password'); const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(em,'admin@khareedo.pk'); set(pw,'Admin@123'); return 'ok'; })()" >/dev/null 2>&1
agent-browser eval "document.querySelector('form')?.requestSubmit()" >/dev/null 2>&1
agent-browser wait 3500 >/dev/null 2>&1
agent-browser open "http://localhost:3000/admin/orders" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({links: [...document.querySelectorAll('tbody a')].map(a=>a.textContent.trim()).slice(0,6), rowLinks: [...document.querySelectorAll('tbody tr')].slice(0,2).map(tr=>[...tr.querySelectorAll('a')].map(a=>a.textContent.trim()))})"

echo "=== /cart aria labels ==="
agent-browser open "http://localhost:3000/cart" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "JSON.stringify({heading: document.querySelector('h1')?.textContent, qtyBtns: [...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(Boolean).slice(0,6), subtotal: document.body.textContent.match(/Subtotal[^.]*\\(\\d+ item[^)]*\\)/)?.[0]})"
