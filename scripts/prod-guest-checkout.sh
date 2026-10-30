#!/bin/bash
cd /home/z/my-project
curl -s -o /dev/null -w "PROD=%{http_code}\n" http://localhost:3000/

agent-browser set viewport 1280 900 >/dev/null
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "http://localhost:3000/product/casio-mens-analog-watch" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser eval "[...document.querySelectorAll('button')].find(b=>/add to cart/i.test(b.getAttribute('aria-label')||''))?.click()" >/dev/null 2>&1
agent-browser wait 2000 >/dev/null 2>&1
echo "cart cookie: $(agent-browser cookies | grep -c cart)"
agent-browser open "http://localhost:3000/checkout" >/dev/null 2>&1
agent-browser wait 2500 >/dev/null 2>&1
echo "url: $(agent-browser eval "location.pathname")"
agent-browser eval "JSON.stringify({h1: document.querySelector('h1')?.textContent, labels: [...document.querySelectorAll('label')].map(l=>l.textContent.trim()).slice(0,10), bodyStart: document.body.textContent.replace(/\\s+/g,' ').slice(0,300)})"
