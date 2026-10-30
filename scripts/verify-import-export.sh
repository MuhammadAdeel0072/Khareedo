#!/usr/bin/env bash
# End-to-end verification of admin Excel/PDF export + import (single server session).
set -u
cd /home/z/my-project
PASS=0; FAIL=0
ck() { if [ "$1" = "ok" ]; then PASS=$((PASS+1)); echo "  PASS: $2"; else FAIL=$((FAIL+1)); echo "  FAIL: $2 (got: $3)"; fi; }

echo "== 0. build test xlsx =="
set -a; source .env; set +a
node scripts/make-test-xlsx.mjs || { echo "xlsx build failed"; exit 1; }

echo "== 1. start production server =="
NODE_ENV=production bun .next/standalone/server.js > server.log 2>&1 &
SRV=$!
up=0
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:3000/ && up=1 && break
  sleep 1
done
[ "$up" = "1" ] && ck ok "server ready" || { ck no "server ready" "timeout"; exit 1; }

echo "== 2. admin login (NextAuth credentials) =="
JAR=/tmp/kh-jar.txt; rm -f "$JAR"
CSRF=$(curl -s -c "$JAR" http://localhost:3000/api/auth/csrf | sed 's/.*"csrfToken":"\([^"]*\)".*/\1/')
login=$(curl -s -b "$JAR" -c "$JAR" -X POST http://localhost:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=admin@khareedo.pk" \
  --data-urlencode "password=Admin@123" --data-urlencode "json=true" \
  -o /dev/null -w "%{http_code}")
[ "$login" = "200" ] && ck ok "login 200" || ck no "login 200" "$login"

echo "== 3. auth guards =="
code=$(curl -s "http://localhost:3000/api/admin/export?type=reports&format=xlsx" -o /dev/null -w "%{http_code}")
[ "$code" = "401" ] && ck ok "export without cookie -> 401" || ck no "export without cookie -> 401" "$code"
code=$(curl -s "http://localhost:3000/api/admin/import/products/template" -o /dev/null -w "%{http_code}")
[ "$code" = "401" ] && ck ok "template without cookie -> 401" || ck no "template without cookie -> 401" "$code"

echo "== 4. customer session must not export =="
CJAR=/tmp/kh-cjar.txt; rm -f "$CJAR"
CCSRF=$(curl -s -c "$CJAR" http://localhost:3000/api/auth/csrf | sed 's/.*"csrfToken":"\([^"]*\)".*/\1/')
ccode=$(curl -s -b "$CJAR" -c "$CJAR" -X POST http://localhost:3000/api/auth/callback/credentials \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CCSRF" \
  --data-urlencode "email=ali.hassan@example.com" \
  --data-urlencode "password=Customer@123" --data-urlencode "json=true" -o /dev/null -w "%{http_code}")
code=$(curl -s -b "$CJAR" "http://localhost:3000/api/admin/export?type=orders&format=xlsx" -o /dev/null -w "%{http_code}")
[ "$code" = "403" ] && ck ok "customer export -> 403" || ck no "customer export -> 403" "$code (login=$ccode)"

echo "== 5. all export combos (admin) =="
for t in reports products orders customers; do
  for f in xlsx pdf; do
    out="/home/z/my-project/scripts/tmp-$t.$f"
    code=$(curl -s -b "$JAR" "http://localhost:3000/api/admin/export?type=$t&format=$f" -o "$out" -w "%{http_code}")
    mime=$(curl -s -b "$JAR" "http://localhost:3000/api/admin/export?type=$t&format=$f" -o /dev/null -w "%{content_type}")
    magic=$(head -c 4 "$out" | tr -d '\0')
    if [ "$f" = "xlsx" ]; then want="PK"; headc=$(head -c 2 "$out"); else want="%PDF"; headc=$(head -c 4 "$out"); fi
    disp=$(curl -s -D - -o /dev/null -b "$JAR" "http://localhost:3000/api/admin/export?type=$t&format=$f" | rg -i "content-disposition" | head -1 | tr -d '\r')
    size=$(stat -c%s "$out" 2>/dev/null || echo 0)
    if [ "$code" = "200" ] && [ "$headc" = "$want" ] && [ "$size" -gt 1000 ]; then
      ck ok "$t/$f 200 + magic '$want' + ${size}B [$disp]"
    else
      ck no "$t/$f 200 + magic + size" "code=$code magic=$magic size=$size mime=$mime"
    fi
    unset disp
  done
done

echo "== 6. template download =="
code=$(curl -s -b "$JAR" "http://localhost:3000/api/admin/import/products/template" -o scripts/tmp-template.xlsx -w "%{http_code}")
magic=$(head -c 2 scripts/tmp-template.xlsx)
[ "$code" = "200" ] && [ "$magic" = "PK" ] && ck ok "template 200 + xlsx magic" || ck no "template 200 + xlsx magic" "code=$code magic=$magic"

echo "== 7. import upload =="
resp=$(curl -s -b "$JAR" -X POST "http://localhost:3000/api/admin/import/products" -F "file=@/home/z/my-project/scripts/tmp-import.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
echo "  response: $resp"
created=$(echo "$resp" | sed -n 's/.*"created":\([0-9]*\).*/\1/p')
skipped=$(echo "$resp" | sed -n 's/.*"skipped":\([0-9]*\).*/\1/p')
failed=$(echo "$resp" | sed -n 's/.*"failed":\([0-9]*\).*/\1/p')
[ "$created" = "2" ] && ck ok "import created=2" || ck no "import created=2" "$created"
[ "$skipped" = "1" ] && ck ok "import skipped=1 (existing name)" || ck no "import skipped=1" "$skipped"
[ "$failed" = "1" ] && ck ok "import failed=1 (bad category)" || ck no "import failed=1" "$failed"

echo "== 8. re-import is idempotent (dup skip) =="
resp2=$(curl -s -b "$JAR" -X POST "http://localhost:3000/api/admin/import/products" -F "file=@/home/z/my-project/scripts/tmp-import.xlsx")
created2=$(echo "$resp2" | sed -n 's/.*"created":\([0-9]*\).*/\1/p')
[ "$created2" = "0" ] && ck ok "second import created=0" || ck no "second import created=0" "$created2"

echo "== 9. verify DB rows + auto SKU/slug/stock, then clean up =="
node scripts/cleanup-import-test.mjs | tee /tmp/cleanup-out.txt
grep -q 'cleaned=2' /tmp/cleanup-out.txt && ck ok "2 smoke products verified + removed" || ck no "cleanup removed 2" "see above"
grep -q '"sku":"KH-' /tmp/cleanup-out.txt && ck ok "auto-SKU generated (KH-…)" || ck no "auto-SKU" "missing"

echo "== 10. storefront unaffected (51 products) =="
node -e "import('@prisma/client').then(async ({PrismaClient})=>{const db=new PrismaClient();console.log('products='+await db.product.count({where:{deletedAt:null}}));await db.\$disconnect()})"

echo "== done =="
kill -9 $SRV 2>/dev/null
echo "PASS=$PASS FAIL=$FAIL"
