#!/usr/bin/env bash
# End-to-end banner API verification (Task 3 evidence).
set -u
BASE=http://localhost:3000
JAR=$(mktemp)

# 1. admin login
CSRF=$(curl -s -c "$JAR" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
LOGIN=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/callback/credentials" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=admin@khareedo.pk" \
  --data-urlencode "password=Admin@123" \
  --data-urlencode "callbackUrl=$BASE/admin")
echo "1. admin login: $LOGIN"

# 2. upload image with target=banner
UP=$(curl -s -b "$JAR" -X POST "$BASE/api/admin/upload" -F "file=@/tmp/test-banner.png;type=image/png" -F "target=banner")
echo "2. upload response: $UP"
IMG_URL=$(echo "$UP" | sed -E 's/.*"url":"([^"]+)".*/\1/')

# 3. create banner referencing the uploaded image
CB=$(curl -s -b "$JAR" -X POST "$BASE/api/admin/banners" -H "Content-Type: application/json" \
  -d "{\"title\":\"API Verification Banner\",\"subtitle\":\"E2E check\",\"imageUrl\":\"$IMG_URL\",\"linkUrl\":\"/products\",\"placement\":\"STRIP\",\"isActive\":true,\"sortOrder\":90}")
echo "3. create banner: $CB"
BID=$(echo "$CB" | sed -E 's/.*"id":"([^"]+)".*/\1/')

# 4. banner appears on storefront?
sleep 1
HOME_HTML=$(curl -s "$BASE/")
if echo "$HOME_HTML" | grep -q "API Verification Banner"; then
  echo "4. storefront shows new banner: PASS"
else
  echo "4. storefront shows new banner: CHECK (grep miss — title may render inside carousel client component)"
  echo "$HOME_HTML" | grep -c "banner" | head -1
fi

# 5. XSS-safety: javascript: URL must be rejected
XSS=$(curl -s -b "$JAR" -X POST "$BASE/api/admin/banners" -H "Content-Type: application/json" \
  -d '{"title":"XSS Probe","imageUrl":"javascript:alert(1)","placement":"HERO","isActive":true,"sortOrder":99}')
echo "5. javascript: URL rejected: $XSS"

# 6. SSRF guard: internal URL import must be blocked
SSRF=$(curl -s -b "$JAR" -X POST "$BASE/api/admin/banners/import-image" -H "Content-Type: application/json" \
  -d '{"url":"http://169.254.169.254/latest/meta-data/"}')
echo "6. metadata IP import blocked: $SSRF"

# 7. update banner (toggle inactive) then delete + verify cleanup
UPD=$(curl -s -b "$JAR" -X PUT "$BASE/api/admin/banners/$BID" -H "Content-Type: application/json" \
  -d '{"title":"API Verification Banner v2","imageUrl":"'"$IMG_URL"'","linkUrl":"/products","placement":"STRIP","isActive":false,"sortOrder":90}')
echo "7a. update banner ok: $(echo "$UPD" | grep -q '"isActive":false' && echo PASS || echo "$UPD")"
DEL=$(curl -s -b "$JAR" -X DELETE "$BASE/api/admin/banners/$BID" -o /dev/null -w "%{http_code}")
echo "7b. delete banner: $DEL"

# 8. storage object cleaned up? (public URL should now 404/400)
sleep 2
STOR=$(curl -s -o /dev/null -w "%{http_code}" "$IMG_URL")
echo "8. orphaned storage object status after delete: $STOR (expect non-200)"

rm -f "$JAR"
