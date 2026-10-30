#!/usr/bin/env bash
set -u
cd /home/z/my-project
NODE_ENV=production bun .next/standalone/server.js > server.log 2>&1 &
SRV=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/ && break; sleep 1; done
AB="agent-browser"
$AB open http://localhost:3000/admin/login > /dev/null 2>&1; sleep 1
$AB find label "Email address" fill "admin@khareedo.pk" > /dev/null 2>&1
$AB find label "Password" fill "Admin@123" > /dev/null 2>&1
$AB find role button click --name "Sign In to Admin" > /dev/null 2>&1
sleep 3
echo "URL after login: $($AB get url 2>/dev/null)"

echo "--- REPORTS:"
$AB open http://localhost:3000/admin/reports > /dev/null 2>&1; sleep 1
$AB snapshot -i -c 2>/dev/null | rg -i "Excel|PDF" | head -4

echo "--- PRODUCTS:"
$AB open http://localhost:3000/admin/products > /dev/null 2>&1; sleep 1
$AB snapshot -i -c 2>/dev/null | rg -i "Import Excel|link \"Excel|button \"Excel|PDF|Add Product" | head -5

echo "--- IMPORT DIALOG:"
$AB find role button click --name "Import Excel" > /dev/null 2>&1; sleep 1
$AB snapshot -c 2>/dev/null | rg -i "template|Import products|template first|xlsx" | head -5
$AB screenshot /home/z/my-project/scripts/tmp-import-dialog.png > /dev/null 2>&1
$AB press Escape > /dev/null 2>&1

echo "--- ORDERS:"
$AB open http://localhost:3000/admin/orders > /dev/null 2>&1; sleep 1
$AB snapshot -i -c 2>/dev/null | rg -i "Excel|PDF" | head -3

echo "--- CUSTOMERS:"
$AB open http://localhost:3000/admin/customers > /dev/null 2>&1; sleep 1
$AB snapshot -i -c 2>/dev/null | rg -i "Excel|PDF" | head -3

echo "--- REPORTS screenshot (desktop):"
$AB open http://localhost:3000/admin/reports > /dev/null 2>&1; sleep 1
$AB screenshot /home/z/my-project/scripts/tmp-reports-page.png > /dev/null 2>&1

$AB close > /dev/null 2>&1
kill -9 $SRV 2>/dev/null
echo "UI CHECK DONE"
