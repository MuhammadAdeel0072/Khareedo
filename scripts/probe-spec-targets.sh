#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done
agent-browser set viewport 1280 900 >/dev/null

echo "=== GUEST checkout step1 (clear cookies) ==="
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "http://localhost:3000/product/casio-mens-analog-watch" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "[...document.querySelectorAll('button')].find(b=>/add to cart/i.test(b.getAttribute('aria-label')||b.textContent))?.click()" >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
echo "toast: $(agent-browser eval "document.body.textContent.includes('Added to cart') || [...document.querySelectorAll('[data-sonner-toast]')].map(t=>t.textContent).join('|')")"
agent-browser open "http://localhost:3000/checkout" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({labels: [...document.querySelectorAll('label')].map(l=>l.textContent.trim()).slice(0,8), btns: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t&&t.length<30).slice(0,6)})"

echo "=== ADMIN dialog labels ==="
agent-browser open "http://localhost:3000/admin/login" >/dev/null 2>&1
agent-browser wait 1200 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(i.find(x=>x.type==='email'),'admin@khareedo.pk'); set(i.find(x=>x.type==='password'),'Admin@123'); document.querySelector('form')?.requestSubmit(); return 'ok'; })()" >/dev/null 2>&1
agent-browser wait 3500 >/dev/null 2>&1
agent-browser open "http://localhost:3000/admin/products" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "[...document.querySelectorAll('button')].find(x=>/add product/i.test(x.textContent))?.click()" >/dev/null 2>&1
agent-browser wait 1000 >/dev/null 2>&1
agent-browser eval "JSON.stringify({labels: [...document.querySelectorAll('[role=dialog] label')].map(l=>l.textContent.trim()), btns: [...document.querySelectorAll('[role=dialog] button')].map(b=>b.textContent.trim()).filter(Boolean)})"

echo "=== INVENTORY row controls ==="
agent-browser open "http://localhost:3000/admin/inventory" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({firstRowInputs: [...document.querySelectorAll('tbody tr')][0] ? [...[...document.querySelectorAll('tbody tr')][0].querySelectorAll('input')].map(i=>i.type) : null, updateBtn: [...[...document.querySelectorAll('tbody tr')][0]?.querySelectorAll('button') ?? []].map(b=>b.textContent.trim())})"

echo "=== ORDER VIEW status strings ==="
agent-browser open "http://localhost:3000/admin/orders?status=PENDING" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "(() => { const m=[...document.querySelectorAll('tbody a')].find(a=>a.textContent.trim()==='Manage'); if(m) m.click(); return 'clicked'; })()" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({url: location.pathname, hasUpdateStatus: document.body.textContent.includes('Update status'), statusBtns: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>/confirm|process|ship|deliver|cancel/i.test(t)).slice(0,6)})"

echo "=== CUSTOMER hits /admin (Forbidden check) ==="
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "http://localhost:3000/login" >/dev/null 2>&1
agent-browser wait 1200 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(i.find(x=>x.type==='email'),'ali.hassan@example.com'); set(i.find(x=>x.type==='password'),'Customer@123'); document.querySelector('form')?.requestSubmit(); return 'ok'; })()" >/dev/null 2>&1
agent-browser wait 3000 >/dev/null 2>&1
agent-browser open "http://localhost:3000/admin" >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
echo "result: $(agent-browser eval "JSON.stringify({url: location.href.replace('http://localhost:3000',''), hasForbidden: document.body.textContent.includes('does not have administrator access')})")"
