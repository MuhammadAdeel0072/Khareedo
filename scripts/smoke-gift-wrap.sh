#!/bin/bash
# Smoke test: per-item gift wrap (Task 8)
# Scenario from user report: cart has 2 products; wrap ONLY the first one;
# system must know exactly which product is wrapped and charge per-item.
set -e
cd /home/z/my-project
J=/home/z/my-project/scripts/.smoke-jar; rm -f "$J"
B=http://localhost:3000

echo "── 1) pick two different products"
PIDS=$(node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  const ps=await db.product.findMany({where:{status:'PUBLISHED',deletedAt:null,inventory:{quantity:{gte:2}}},select:{id:true},take:2,orderBy:{createdAt:'asc'}});
  if(ps.length<2){console.error('need 2 products');process.exit(1);}
  console.log(ps[0].id+' '+ps[1].id);
  await db.\$disconnect();
})();")
P1=$(echo $PIDS | cut -d' ' -f1); P2=$(echo $PIDS | cut -d' ' -f2)
echo "P1=$P1 P2=$P2"

echo "── 2) add both to guest cart"
curl -s -c "$J" -b "$J" -X POST $B/api/cart -H 'Content-Type: application/json' -d "{\"productId\":\"$P1\",\"quantity\":1}" >/dev/null
curl -s -c "$J" -b "$J" -X POST $B/api/cart -H 'Content-Type: application/json' -d "{\"productId\":\"$P2\",\"quantity\":1}" >/dev/null

CART=$(curl -s -c "$J" -b "$J" $B/api/cart)
ITEM1=$(echo "$CART" | python3 -c "import sys,json;print(json.load(sys.stdin)['cart']['items'][0]['itemId'])")
ITEM2=$(echo "$CART" | python3 -c "import sys,json;print(json.load(sys.stdin)['cart']['items'][1]['itemId'])")
echo "items: $ITEM1 / $ITEM2"

echo "── 3) gift-wrap ONLY the FIRST item"
W=$(curl -s -c "$J" -b "$J" -X PATCH $B/api/cart -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEM1\",\"giftWrap\":true}")
echo "$W" | python3 -c "
import sys,json
c=json.load(sys.stdin)['cart']
flags=[(i['name'][:28], i['giftWrap']) for i in c['items']]
assert flags[0][1] is True,  'item 1 must be wrapped'
assert flags[1][1] is False, 'item 2 must NOT be wrapped'
assert c['wrappedUnits']==1, f\"wrappedUnits must be 1, got {c['wrappedUnits']}\"
print('   cart flags OK:', flags, '| wrappedUnits =', c['wrappedUnits'])
"

echo "── 4) server quote (no gift flag sent by client at all)"
Q=$(curl -s -c "$J" -b "$J" -X POST $B/api/checkout/quote -H 'Content-Type: application/json' -d '{"deliveryMethod":"STANDARD"}')
echo "$Q" | python3 -c "
import sys,json
q=json.load(sys.stdin)['quote']
assert q['wrappedUnits']==1, q
assert q['giftWrapCharge']==150, f\"expected 150, got {q['giftWrapCharge']}\"
print('   quote OK: giftWrapCharge = Rs', q['giftWrapCharge'], '| wrappedUnits =', q['wrappedUnits'], '| total = Rs', q['total'])
"

echo "── 5) wrap the second item too, then unwrap the first → charge must follow the toggles"
curl -s -c "$J" -b "$J" -X PATCH $B/api/cart -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEM2\",\"giftWrap\":true}" >/dev/null
curl -s -c "$J" -b "$J" -X PATCH $B/api/cart -H 'Content-Type: application/json' -d "{\"itemId\":\"$ITEM1\",\"giftWrap\":false}" >/dev/null
curl -s -c "$J" -b "$J" -X POST $B/api/checkout/quote -H 'Content-Type: application/json' -d '{"deliveryMethod":"STANDARD"}' | python3 -c "
import sys,json
q=json.load(sys.stdin)['quote']
assert q['giftWrapCharge']==150 and q['wrappedUnits']==1, q
print('   toggles tracked OK: charge stays Rs 150, now on item 2')
"

echo "── 6) place order → per-item wrap must be snapshotted"
REF=$(curl -s -c "$J" -b "$J" -X POST $B/api/checkout/place -H 'Content-Type: application/json' -d '{
  "idempotencyKey":"smoke-gw-0001-abcdefghij12",
  "customer":{"name":"Smoke Tester","email":"smoke@example.com","phone":"03001234567"},
  "address":{"fullName":"Smoke Tester","phone":"03001234567","line1":"House 12, Street 5","city":"Lahore","province":"Punjab"},
  "deliveryMethod":"STANDARD","paymentMethod":"COD","giftWrapMessage":"Happy Birthday!"
}' | python3 -c "import sys,json;d=json.load(sys.stdin);assert d.get('ok'),d;print(d['reference'])")
echo "   order reference: $REF"

node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  const o=await db.order.findUnique({where:{reference:'$REF'},include:{items:true}});
  const wrapped=o.items.filter(i=>i.giftWrap).map(i=>i.productName);
  const plain=o.items.filter(i=>!i.giftWrap).map(i=>i.productName);
  console.assert(o.giftWrapCharge===150,'charge 150');
  console.assert(o.giftWrapSelected===true,'selected');
  console.assert(wrapped.length===1&&plain.length===1,'one wrapped one plain');
  console.log('   OrderItem snapshot OK → wrapped:',wrapped,'| plain:',plain,'| charge:',o.giftWrapCharge);
  await db.\$disconnect();
})();
"

echo "── 7) cleanup test order + cart"
node -e "
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
(async()=>{
  const o=await db.order.findUnique({where:{reference:'$REF'}});
  await db.order.delete({where:{id:o.id}});
  await db.\$disconnect(); console.log('   test order removed');
})();
"
echo "ALL SMOKE CHECKS PASSED"