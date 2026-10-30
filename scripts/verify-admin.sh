#!/bin/bash
cd /home/z/my-project
setsid nohup npm run dev > dev.log 2>&1 < /dev/null & disown
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done

agent-browser set viewport 1366 900 >/dev/null

echo "=== Admin login ==="
agent-browser open "http://localhost:3000/admin/login" >/dev/null 2>&1
agent-browser wait 1500 >/dev/null 2>&1
agent-browser snapshot -i 2>/dev/null | grep -E "textbox|button" | head -4

agent-browser eval "(() => { const inputs=[...document.querySelectorAll('input')]; const em=inputs.find(i=>/email/i.test(i.type+i.name+i.id)); const pw=inputs.find(i=>i.type==='password'); if(em){em.value='admin@khareedo.pk'; em.dispatchEvent(new Event('input',{bubbles:true}))} if(pw){pw.value='Admin@123'; pw.dispatchEvent(new Event('input',{bubbles:true}))} return 'filled'; })()" >/dev/null 2>&1
agent-browser eval "document.querySelector('form')?.requestSubmit()" >/dev/null 2>&1
agent-browser wait 3500 >/dev/null 2>&1
echo "AFTER_LOGIN: $(agent-browser eval "location.pathname")"

echo "=== Admin pages render check ==="
for p in "/admin" "/admin/reports" "/admin/products" "/admin/inventory" "/admin/orders" "/admin/settings"; do
  agent-browser open "http://localhost:3000$p" >/dev/null 2>&1
  agent-browser wait 1800 >/dev/null 2>&1
  ov=$(agent-browser eval "document.documentElement.scrollWidth - document.documentElement.clientWidth" 2>/dev/null)
  err=$(agent-browser errors 2>/dev/null | wc -l)
  echo "$p overflow=$ov"
done

echo "=== Add Product dialog opens (like Add Category) ==="
agent-browser open "http://localhost:3000/admin/products" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>/add product/i.test(x.textContent)); if(b) b.click(); return !!b; })()"
agent-browser wait 1200 >/dev/null 2>&1
agent-browser eval "JSON.stringify({dialogOpen: !!document.querySelector('[role=dialog]'), skuFieldVisible: (() => { const d=document.querySelector('[role=dialog]'); if(!d) return false; return [...d.querySelectorAll('label')].some(l=>/sku/i.test(l.textContent)); })(), nameField: (() => { const d=document.querySelector('[role=dialog]'); return d ? [...d.querySelectorAll('input')].length : 0; })()})"
agent-browser screenshot /tmp/admin_addproduct_dialog.png >/dev/null 2>&1

echo "=== Reports page: low stock table renders ==="
agent-browser open "http://localhost:3000/admin/reports" >/dev/null 2>&1
agent-browser wait 1800 >/dev/null 2>&1
agent-browser eval "JSON.stringify({hasLowStockSection: document.body.textContent.toLowerCase().includes('low stock'), rows: document.querySelectorAll('table tbody tr').length})"
