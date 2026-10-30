#!/bin/bash
cd /home/z/my-project
curl -s -o /dev/null -w "PROD=%{http_code}\n" http://localhost:3000/ || exit 1
agent-browser set viewport 1280 900 >/dev/null
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "http://localhost:3000/login" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "(() => { const i=[...document.querySelectorAll('input')]; const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}))}; set(i.find(x=>x.type==='email'),'sara.khan@example.com'); set(i.find(x=>x.type==='password'),'Customer@123'); document.querySelector('form')?.requestSubmit(); return 'ok'; })()" >/dev/null 2>&1
agent-browser wait 4000 >/dev/null 2>&1
echo "after login: $(agent-browser eval "location.pathname")"
agent-browser open "http://localhost:3000/order/KH26030110021" >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
echo "order page: $(agent-browser eval "JSON.stringify({url: location.pathname, notFound: document.body.textContent.includes('Page not found'), showsOrder: document.body.textContent.includes('KH26030110021'), status: document.body.textContent.match(/DELIVERED|PENDING|SHIPPED/)?.[0]})")"
