#!/usr/bin/env bash
set -u
cd /home/z/my-project
set -a; source .env; set +a
NODE_ENV=production node .next/standalone/server.js > server.log 2>&1 &
SRV=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/ && break; sleep 1; done
JAR=/tmp/kh-jar.txt; rm -f "$JAR"
CSRF=$(curl -s -c "$JAR" http://localhost:3000/api/auth/csrf | sed 's/.*"csrfToken":"\([^"]*\)".*/\1/')
curl -s -b "$JAR" -c "$JAR" -X POST http://localhost:3000/api/auth/callback/credentials -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=admin@khareedo.pk" --data-urlencode "password=Admin@123" --data-urlencode "json=true" -o /dev/null
for t in reports products orders customers; do
  out="scripts/tmp-$t.pdf"
  code=$(curl -s -b "$JAR" "http://localhost:3000/api/admin/export?type=$t&format=pdf" -o "$out" -w "%{http_code}")
  magic=$(head -c 4 "$out")
  size=$(stat -c%s "$out")
  echo "$t/pdf: code=$code magic=$magic size=$size"
done
kill -9 $SRV 2>/dev/null
