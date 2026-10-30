// Khareedo database seed — idempotent (wipes content tables, then inserts).
// Usage: bun scripts/seed.ts
import { PrismaClient } from "../generated/sqlite-client";
import bcrypt from "bcryptjs";
import { PRODUCTS, PARENT_CATEGORIES, LEAF_CATEGORIES } from "./catalog";

const db = new PrismaClient();

const SETTINGS: Record<string, string> = {
  store_name: "Khareedo",
  store_tagline: "Everyday essentials. Better choices.",
  store_email: "support@khareedo.pk",
  store_phone: "+92 300 1234567",
  store_address: "Gulberg III, Lahore, Pakistan",
  whatsapp_number: "923001234567",
  announcement_text: "Free Delivery on Orders Above Rs 3,000",
  cod_enabled: "true",
  bank_transfer_enabled: "false",
  online_payment_enabled: "false",
  delivery_fee_standard: "200",
  delivery_fee_express: "400",
  free_delivery_threshold: "3000",
  gift_wrap_enabled: "true",
  gift_wrap_charge: "150",
  gift_wrap_description: "Premium gift wrapping with ribbon and a personalized note",
  facebook_url: "https://facebook.com/khareedo",
  instagram_url: "https://instagram.com/khareedo",
};

async function main() {
  console.log("Seeding Khareedo database...");

  // 1) Settings (upsert — never delete)
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.storeSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
  console.log("✓ Store settings");

  // 2) Wipe transactional/content data (FK-safe order)
  await db.payment.deleteMany();
  await db.orderItem.deleteMany();
  await db.order.deleteMany();
  await db.cartItem.deleteMany();
  await db.cart.deleteMany();
  await db.wishlistItem.deleteMany();
  await db.inventory.deleteMany();
  await db.productImage.deleteMany();
  await db.product.deleteMany();
  await db.category.deleteMany();
  await db.banner.deleteMany();
  await db.coupon.deleteMany();
  await db.promotion.deleteMany();
  await db.address.deleteMany();
  await db.user.deleteMany({ where: { role: { in: ["CUSTOMER", "ADMIN"] } } });

  // 3) Categories
  const catIds = new Map<string, string>();
  for (const parent of PARENT_CATEGORIES) {
    const c = await db.category.create({
      data: {
        name: parent.name,
        slug: parent.slug,
        description: parent.description,
        isActive: true,
        sortOrder: parent.sortOrder,
      },
    });
    catIds.set(parent.slug, c.id);
  }
  for (const leaf of LEAF_CATEGORIES) {
    const c = await db.category.create({
      data: {
        name: leaf.name,
        slug: leaf.slug,
        description: leaf.description,
        parentId: leaf.parent ? catIds.get(leaf.parent) : null,
        isActive: true,
        sortOrder: leaf.sortOrder,
      },
    });
    catIds.set(leaf.slug, c.id);
  }
  console.log(`✓ Categories (${PARENT_CATEGORIES.length + LEAF_CATEGORIES.length})`);

  // 4) Products + images + inventory
  let n = 0;
  for (const p of PRODUCTS) {
    const created = await db.product.create({
      data: {
        name: p.name,
        slug: p.slug,
        description: p.description,
        brand: p.brand,
        sku: `KH-${p.slug.slice(0, 10).toUpperCase()}-${n + 1}`,
        categoryId: catIds.get(p.category)!,
        price: p.price,
        comparePrice: p.comparePrice ?? null,
        status: "PUBLISHED",
        isFeatured: p.featured ?? false,
        rating: p.rating,
        reviewCount: p.reviewCount,
        tags: p.tags.join(","),
        images: {
          create: [{ url: `/images/products/${p.slug}.png`, alt: p.name, sortOrder: 0 }],
        },
      },
    });
    await db.inventory.create({
      data: {
        productId: created.id,
        quantity: p.stock,
        lowStockThreshold: 5,
      },
    });
    n++;
  }
  console.log(`✓ Products (${n}) with images & inventory`);

  // 5) Users (demo credentials documented in README)
  const adminHash = await bcrypt.hash("Admin@123", 12);
  const customerHash = await bcrypt.hash("Customer@123", 12);
  const admin = await db.user.create({
    data: {
      email: "admin@khareedo.pk",
      name: "Store Administrator",
      passwordHash: adminHash,
      role: "ADMIN",
      phone: "03001234567",
      emailVerified: new Date(),
    },
  });
  const ali = await db.user.create({
    data: {
      email: "ali.hassan@example.com",
      name: "Ali Hassan",
      passwordHash: customerHash,
      role: "CUSTOMER",
      phone: "03001234567",
      emailVerified: new Date(),
    },
  });
  const sara = await db.user.create({
    data: {
      email: "sara.khan@example.com",
      name: "Sara Khan",
      passwordHash: customerHash,
      role: "CUSTOMER",
      phone: "03219876543",
      emailVerified: new Date(),
    },
  });
  console.log("✓ Users (admin + 2 demo customers)");

  await db.address.createMany({
    data: [
      {
        userId: ali.id,
        label: "Home",
        fullName: "Ali Hassan",
        phone: "03001234567",
        line1: "House No 12, Street 5, Gulberg",
        city: "Lahore",
        province: "Punjab",
        postalCode: "54000",
        isDefault: true,
      },
      {
        userId: ali.id,
        label: "Office",
        fullName: "Ali Hassan",
        phone: "03001234567",
        line1: "Office No 45, 3rd Floor, Tech Tower, Johar Town",
        city: "Lahore",
        province: "Punjab",
        postalCode: "54000",
        isDefault: false,
      },
      {
        userId: sara.id,
        label: "Home",
        fullName: "Sara Khan",
        phone: "03219876543",
        line1: "Flat 3-B, Clifton Block 2",
        city: "Karachi",
        province: "Sindh",
        postalCode: "75600",
        isDefault: true,
      },
    ],
  });
  console.log("✓ Demo addresses");

  // 6) Banners (hero carousel + side promos)
  await db.banner.createMany({
    data: [
      {
        title: "Everyday essentials. Better choices.",
        subtitle: "Discover watches, accessories, and everyday favourites — all in one place at Khareedo.",
        imageUrl: "/images/banners/hero-main.png",
        linkUrl: "/products",
        placement: "HERO",
        isActive: true,
        sortOrder: 1,
      },
      {
        title: "New Collection Smart Watches",
        subtitle: "Style meets smart living — call, track and move.",
        imageUrl: "/images/banners/hero-2.png",
        linkUrl: "/products?category=smart-watches",
        placement: "HERO",
        isActive: true,
        sortOrder: 2,
      },
      {
        title: "Gift Something Special",
        subtitle: "Perfumes, jewellery and watches with gift wrapping available at checkout.",
        imageUrl: "/images/banners/hero-3.png",
        linkUrl: "/products?category=perfumes",
        placement: "HERO",
        isActive: true,
        sortOrder: 3,
      },
      {
        title: "New Collection Smart Watches",
        subtitle: "Style Meets Smart Living",
        imageUrl: "/images/banners/side-smartwatch.png",
        linkUrl: "/products?category=smart-watches",
        placement: "SIDE",
        isActive: true,
        sortOrder: 1,
      },
      {
        title: "Best Sound Earbuds",
        subtitle: "Clear Sound All Day",
        imageUrl: "/images/banners/side-earbuds.png",
        linkUrl: "/products?category=earbuds",
        placement: "SIDE",
        isActive: true,
        sortOrder: 2,
      },
    ],
  });
  console.log("✓ Banners");

  // 7) Coupons (confirmed rules: PERCENT/FIXED, min order, expiry, usage limit)
  await db.coupon.createMany({
    data: [
      {
        code: "WELCOME10",
        description: "10% off your first order (min Rs 2,000)",
        type: "PERCENT",
        value: 10,
        minOrderAmount: 2000,
        isActive: true,
      },
      {
        code: "SAVE500",
        description: "Rs 500 off orders above Rs 5,000",
        type: "FIXED",
        value: 500,
        minOrderAmount: 5000,
        isActive: true,
      },
      {
        code: "EID20",
        description: "20% off orders above Rs 4,000 — limited to 100 uses",
        type: "PERCENT",
        value: 20,
        minOrderAmount: 4000,
        maxUses: 100,
        isActive: true,
      },
    ],
  });
  console.log("✓ Coupons");

  // 8) Promotions
  await db.promotion.createMany({
    data: [
      {
        title: "Mid-Season Sale",
        description: "Up to 20% off on selected watches and earbuds. Limited time only.",
        type: "PERCENT",
        value: 20,
        isActive: true,
      },
    ],
  });
  console.log("✓ Promotions");

  // 9) Demo orders — real DB records so dashboards/reports have data (demo store).
  const products = await db.product.findMany({
    include: { images: { take: 1, orderBy: { sortOrder: "asc" } } },
  });
  const bySlug = new Map(products.map((p) => [p.slug, p]));

  interface DemoOrder {
    ref: string;
    user: string | null;
    name: string;
    email: string;
    phone: string;
    city: string;
    province: string;
    line1: string;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    items: Array<[string, number]>; // slug, qty
    daysAgo: number;
    deliveryFee: number;
  }

  const demoOrders: DemoOrder[] = [
    {
      ref: "KH26030110021", user: ali.id, name: "Ali Hassan", email: "ali.hassan@example.com",
      phone: "03001234567", city: "Lahore", province: "Punjab", line1: "House No 12, Street 5, Gulberg",
      status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PAID",
      items: [["soundpeats-q3-pro-anc", 1], ["casio-mens-analog-watch", 1], ["classic-leather-handbag", 1]],
      daysAgo: 26, deliveryFee: 0,
    },
    {
      ref: "KH26030410022", user: sara.id, name: "Sara Khan", email: "sara.khan@example.com",
      phone: "03219876543", city: "Karachi", province: "Sindh", line1: "Flat 3-B, Clifton Block 2",
      status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PAID",
      items: [["timex-classic-leather-watch", 1]], daysAgo: 23, deliveryFee: 0,
    },
    {
      ref: "KH26030710023", user: null, name: "Usman Ali", email: "usman.ali@example.com",
      phone: "03331122334", city: "Islamabad", province: "Islamabad Capital Territory", line1: "Plot 8, Street 12, F-11/3",
      status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PAID",
      items: [["rose-gold-mesh-ladies-watch", 1], ["pearl-drop-earrings", 2]], daysAgo: 20, deliveryFee: 200,
    },
    {
      ref: "KH26031010024", user: ali.id, name: "Ali Hassan", email: "ali.hassan@example.com",
      phone: "03001234567", city: "Lahore", province: "Punjab", line1: "House No 12, Street 5, Gulberg",
      status: "SHIPPED", paymentMethod: "COD", paymentStatus: "PENDING",
      items: [["amoled-smart-watch-ultra", 1]], daysAgo: 14, deliveryFee: 0,
    },
    {
      ref: "KH26031410025", user: sara.id, name: "Sara Khan", email: "sara.khan@example.com",
      phone: "03219876543", city: "Karachi", province: "Sindh", line1: "Flat 3-B, Clifton Block 2",
      status: "PROCESSING", paymentMethod: "COD", paymentStatus: "PENDING",
      items: [["noir-intense-eau-de-parfum", 1], ["genuine-leather-wallet", 1]], daysAgo: 10, deliveryFee: 0,
    },
    {
      ref: "KH26031810026", user: null, name: "Bilal Ahmed", email: "bilal.ahmed@example.com",
      phone: "03455566778", city: "Faisalabad", province: "Punjab", line1: "Peoples Colony No 1, Block C",
      status: "PROCESSING", paymentMethod: "COD", paymentStatus: "PENDING",
      items: [["boat-airdopes-141", 2], ["skmei-sport-digital-watch", 1], ["braided-usb-c-cable", 3], ["clover-necklace-set", 1]], daysAgo: 7, deliveryFee: 0,
    },
    {
      ref: "KH26032210027", user: sara.id, name: "Sara Khan", email: "sara.khan@example.com",
      phone: "03219876543", city: "Karachi", province: "Sindh", line1: "Flat 3-B, Clifton Block 2",
      status: "CONFIRMED", paymentMethod: "COD", paymentStatus: "PENDING",
      items: [["anne-klein-bracelet-watch", 1]], daysAgo: 4, deliveryFee: 0,
    },
    {
      ref: "KH26032410028", user: ali.id, name: "Ali Hassan", email: "ali.hassan@example.com",
      phone: "03001234567", city: "Lahore", province: "Punjab", line1: "Office No 45, 3rd Floor, Tech Tower, Johar Town",
      status: "PENDING", paymentMethod: "COD", paymentStatus: "PENDING",
      items: [["xiaomi-smart-band-8", 1], ["rose-gold-matching-pair", 1]], daysAgo: 2, deliveryFee: 0,
    },
    {
      ref: "KH26032510029", user: null, name: "Ayesha Malik", email: "ayesha.malik@example.com",
      phone: "03009988776", city: "Multan", province: "Punjab", line1: "Shah Rukn-e-Alam Colony, Block A",
      status: "CANCELLED", paymentMethod: "COD", paymentStatus: "PENDING",
      items: [["realme-buds-t300", 1]], daysAgo: 1, deliveryFee: 200,
    },
  ];

  for (const o of demoOrders) {
    const lines = o.items.map(([slug, qty]) => {
      const p = bySlug.get(slug)!;
      return { p, qty };
    });
    const subtotal = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - o.daysAgo);

    await db.order.create({
      data: {
        reference: o.ref,
        idempotencyKey: `seed-${o.ref}`,
        userId: o.user,
        isGuest: o.user === null,
        customerName: o.name,
        customerEmail: o.email,
        customerPhone: o.phone,
        shipFullName: o.name,
        shipPhone: o.phone,
        shipLine1: o.line1,
        shipCity: o.city,
        shipProvince: o.province,
        status: o.status,
        paymentMethod: o.paymentMethod,
        paymentStatus: o.paymentStatus,
        subtotal,
        discountTotal: 0,
        deliveryFee: o.deliveryFee,
        deliveryMethod: "STANDARD",
        giftWrapCharge: 0,
        giftWrapSelected: false,
        total: subtotal + o.deliveryFee,
        createdAt,
        items: {
          create: lines.map((l) => ({
            productId: l.p.id,
            productName: l.p.name,
            productSlug: l.p.slug,
            imageUrl: l.p.images[0]?.url ?? null,
            unitPrice: l.p.price,
            quantity: l.qty,
            lineTotal: l.p.price * l.qty,
          })),
        },
        payments: {
          create: {
            provider: o.paymentMethod,
            amount: subtotal + o.deliveryFee,
            status: o.paymentStatus,
            createdAt,
          },
        },
      },
    });
  }
  console.log(`✓ Demo orders (${demoOrders.length})`);

  // 10) Wishlist sample for Ali
  const clover = bySlug.get("clover-necklace-set");
  const fitbit = bySlug.get("fitbit-inspire-3");
  if (clover && fitbit) {
    await db.wishlistItem.createMany({
      data: [
        { userId: ali.id, productId: clover.id },
        { userId: ali.id, productId: fitbit.id },
      ],
    });
    console.log("✓ Sample wishlist");
  }

  console.log(`\nDone. Admin: admin@khareedo.pk / Admin@123 — Customer: ali.hassan@example.com / Customer@123`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
