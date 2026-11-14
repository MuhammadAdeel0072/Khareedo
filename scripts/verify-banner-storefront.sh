#!/usr/bin/env bash
# Focused: SIDE banner appears on storefront; PUT update works.
# NOTE: the storefront renders the top-N SIDE banners (getActiveBanners limit),
# so this script creates the probe banner with sortOrder 0 to win the rank cut.
set -u
BASE=http://localhost:3000
JAR=$(mktemp)
CSRF=$(curl -s -c "$JAR" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/api/auth/callback/credentials" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=admin@khareedo.pk" \
  --data-urlencode "password=Admin@123" \
  --data-urlencode "callbackUrl=$BASE/admin"

UP=$(curl -s -b "$JAR" -X POST "$BASE/api/admin/upload" -F "file=@/tmp/test-banner.png;type=image/png" -F "target=banner")
IMG_URL=$(echo "$UP" | sed -E 's/.*"url":"([^"]+)".*/\1/')
echo "uploaded: $IMG_URL"

CB=$(curl -s -b "$JAR" -X POST "$BASE/api/admin/banners" -H "Content-Type: application/json" \
  -d "{\"title\":\"Storefront Check Banner\",\"subtitle\":\"E2E SIDE\",\"imageUrl\":\"$IMG_URL\",\"linkUrl\":\"/products\",\"placement\":\"SIDE\",\"isActive\":true,\"sortOrder\":1}")
BID=$(echo "$CB" | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "created banner id=$BID placement=$(echo "$CB" | grep -oE '"placement":"[A-Z]*"')"

sleep 1
if curl -s "$BASE/" | grep -q "Storefront Check Banner"; then
  echo "SIDE BANNER ON STOREFRONT: PASS"
else
  echo "SIDE BANNER ON STOREFRONT: FAIL"
  curl -s "$BASE/" | grep -oE "side[^<]{0,40}" | head -3
fi

UPD=$(curl -s -b "$JAR" -X PUT "$BASE/api/admin/banners/$BID" -H "Content-Type: application/json" \
  -d "{\"title\":\"Storefront Check Banner v2\",\"imageUrl\":\"$IMG_URL\",\"linkUrl\":\"/products\",\"placement\":\"SIDE\",\"isActive\":false,\"sortOrder\":1}")
echo "PUT response ok=$(echo "$UPD" | grep -oE '"ok":(true|false)'), isActive=$(echo "$UPD" | grep -oE '"isActive":(true|false)')"

# inactive banner must disappear from storefront
sleep 1
if curl -s "$BASE/" | grep -q "Storefront Check Banner"; then
  echo "INACTIVE HIDDEN: FAIL"
else
  echo "INACTIVE HIDDEN FROM STOREFRONT: PASS"
fi

DEL=$(curl -s -b "$JAR" -X DELETE "$BASE/api/admin/banners/$BID" -o /dev/null -w "%{http_code}")
sleep 1
STOR=$(curl -s -o /dev/null -w "%{http_code}" "$IMG_URL")
echo "delete=$DEL, storage-after-delete=$STOR (expect 400/404)"
rm -f "$JAR"
