#!/bin/bash
# Test credentials come from the environment (chosen when seeding — see
# docs/SEEDING.md). Never hardcode passwords in this repo.
if [ -z "${SEED_ADMIN_PASSWORD:-}" ]; then echo "Set SEED_ADMIN_PASSWORD before running this script." >&2; exit 1; fi
if [ -z "${SEED_CUSTOMER_PASSWORD:-}" ]; then echo "Set SEED_CUSTOMER_PASSWORD before running this script." >&2; exit 1; fi
cd /home/z/my-project
curl -s -o /dev/null -w "PROD=%{http_code}\n" http://localhost:3000/ || { setsid nohup npx next start -p 3000 > /tmp/prod.log 2>&1 < /dev/null & disown; sleep 5; }

agent-browser set viewport 1280 900 >/dev/null
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "http://localhost:3000/login" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(i.find(x=>x.type==='email'),'ali.hassan@example.com'); set(i.find(x=>x.type==='password'),'$SEED_CUSTOMER_PASSWORD'); document.querySelector('form')?.requestSubmit(); return 'ok'; })()" >/dev/null 2>&1
agent-browser wait 4000 >/dev/null 2>&1
echo "after login: $(agent-browser eval "location.pathname")"
agent-browser open "http://localhost:3000/account" >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
agent-browser eval "JSON.stringify({h1: document.querySelector('h1')?.textContent, statLabels: [...document.querySelectorAll('p,span,dt,dd')].map(e=>e.textContent.trim()).filter(t=>/total|order/i.test(t)).slice(0,8), bodySnippet: document.body.textContent.replace(/\\s+/g,' ').slice(0,400)})"

echo "=== non-admin /admin probe (logged in as customer) ==="
agent-browser open "http://localhost:3000/admin" >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
agent-browser eval "JSON.stringify({url: location.href.replace('http://localhost:3000',''), forbiddenText: document.body.textContent.includes('does not have administrator access')})"

echo "=== admin login + /admin/products probe (prod) ==="
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "http://localhost:3000/admin/login" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(i.find(x=>x.type==='email'),'admin@khareedo.pk'); set(i.find(x=>x.type==='password'),'$SEED_ADMIN_PASSWORD'); document.querySelector('form')?.requestSubmit(); return 'ok'; })()" >/dev/null 2>&1
agent-browser wait 4000 >/dev/null 2>&1
echo "after admin login: $(agent-browser eval "location.pathname")"
agent-browser open "http://localhost:3000/admin/products" >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
agent-browser eval "JSON.stringify({addProductBtn: [...document.querySelectorAll('button')].map(b=>({t: b.textContent.trim(), al: b.getAttribute('aria-label')})).filter(x=>/add product/i.test(x.t + ' ' + (x.al||''))).slice(0,2), h1: document.querySelector('h1')?.textContent})"
