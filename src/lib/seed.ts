// Khareedo database seed — safe, non-destructive, opt-in only (PR-06).
//
// Contract (see docs/SEEDING.md):
// - runSeed() refuses unless checkSeedTarget() passes: explicit SEED_ALLOW=1
//   opt-in, never in production, and only a local SQLite `file:` DATABASE_URL.
// - It NEVER deletes rows and NEVER overwrites existing rows. Every write is
//   an upsert that leaves an existing row untouched, or a create-if-missing.
//   Re-running the seed only fills in missing seed data.
// - Accounts are created ONLY when their password is supplied via the
//   environment and passes validateSeedPassword(). An account that already
//   exists is left completely untouched — its password is never reset.
// - No password is ever logged. The summary reports emails only.
//
// The seed is a function of (db, env) so the integration tests exercise the
// exact same code path the CLI wrapper runs.
import bcrypt from "bcryptjs";
import type { PrismaClient } from "../../generated/sqlite-client";
import { LEAF_CATEGORIES, PARENT_CATEGORIES, PRODUCTS } from "../../scripts/catalog";
import { checkSeedTarget, validateSeedPassword } from "./seed-guards";

export interface SeedAccountSpec {
  email: string;
  name: string;
  // User.role is a plain string in the schema ("CUSTOMER" | "ADMIN").
  role: "ADMIN" | "CUSTOMER";
  phone: string;
  passwordEnvVar: "SEED_ADMIN_PASSWORD" | "SEED_CUSTOMER_PASSWORD";
}

/**
 * The accounts the seed can create. These are identifiers only — the seed
 * contains no passwords for them. A password must be supplied per account
 * through the environment (see SEED_ADMIN_PASSWORD / SEED_CUSTOMER_PASSWORD
 * in docs/SEEDING.md); without it the account is simply not created.
 */
export const SEED_ACCOUNTS: SeedAccountSpec[] = [
  {
    email: "admin@khareedo.pk",
    name: "Store Administrator",
    role: "ADMIN",
    phone: "03001234567",
    passwordEnvVar: "SEED_ADMIN_PASSWORD",
  },
  {
    email: "ali.hassan@example.com",
    name: "Ali Hassan",
    role: "CUSTOMER",
    phone: "03001234567",
    passwordEnvVar: "SEED_CUSTOMER_PASSWORD",
  },
  {
    email: "sara.khan@example.com",
    name: "Sara Khan",
    role: "CUSTOMER",
    phone: "03219876543",
    passwordEnvVar: "SEED_CUSTOMER_PASSWORD",
  },
];

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

export interface SeedSummary {
  settingsPresent: number;
  categoriesPresent: number;
  productsPresent: number;
  couponsPresent: number;
  bannersCreated: number;
  promotionsCreated: number;
  ordersCreated: number;
  ordersAlreadyPresent: number;
  usersCreated: string[];
  usersAlreadyPresent: string[];
  usersSkippedNoPassword: string[];
}

interface DemoOrder {
  ref: string;
  userEmail: string | null;
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

// Demo orders — real DB records so dashboards/reports have data (demo store).
// The userEmail links an order to a seeded account; orders for accounts that
// were not created (no password supplied) are skipped, guest orders are not.
const DEMO_ORDERS: DemoOrder[] = [
  {
    ref: "KH26030110021", userEmail: "ali.hassan@example.com", name: "Ali Hassan", email: "ali.hassan@example.com",
    phone: "03001234567", city: "Lahore", province: "Punjab", line1: "House No 12, Street 5, Gulberg",
    status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PAID",
    items: [["soundpeats-q3-pro-anc", 1], ["casio-mens-analog-watch", 1], ["classic-leather-handbag", 1]],
    daysAgo: 26, deliveryFee: 0,
  },
  {
    ref: "KH26030410022", userEmail: "sara.khan@example.com", name: "Sara Khan", email: "sara.khan@example.com",
    phone: "03219876543", city: "Karachi", province: "Sindh", line1: "Flat 3-B, Clifton Block 2",
    status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PAID",
    items: [["timex-classic-leather-watch", 1]], daysAgo: 23, deliveryFee: 0,
  },
  {
    ref: "KH26030710023", userEmail: null, name: "Usman Ali", email: "usman.ali@example.com",
    phone: "03331122334", city: "Islamabad", province: "Islamabad Capital Territory", line1: "Plot 8, Street 12, F-11/3",
    status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PAID",
    items: [["rose-gold-mesh-ladies-watch", 1], ["pearl-drop-earrings", 2]], daysAgo: 20, deliveryFee: 200,
  },
  {
    ref: "KH26031010024", userEmail: "ali.hassan@example.com", name: "Ali Hassan", email: "ali.hassan@example.com",
    phone: "03001234567", city: "Lahore", province: "Punjab", line1: "House No 12, Street 5, Gulberg",
    status: "SHIPPED", paymentMethod: "COD", paymentStatus: "PENDING",
    items: [["amoled-smart-watch-ultra", 1]], daysAgo: 14, deliveryFee: 0,
  },
  {
    ref: "KH26031410025", userEmail: "sara.khan@example.com", name: "Sara Khan", email: "sara.khan@example.com",
    phone: "03219876543", city: "Karachi", province: "Sindh", line1: "Flat 3-B, Clifton Block 2",
    status: "PROCESSING", paymentMethod: "COD", paymentStatus: "PENDING",
    items: [["noir-intense-eau-de-parfum", 1], ["genuine-leather-wallet", 1]], daysAgo: 10, deliveryFee: 0,
  },
  {
    ref: "KH26031810026", userEmail: null, name: "Bilal Ahmed", email: "bilal.ahmed@example.com",
    phone: "03455566778", city: "Faisalabad", province: "Punjab", line1: "Peoples Colony No 1, Block C",
    status: "PROCESSING", paymentMethod: "COD", paymentStatus: "PENDING",
    items: [["boat-airdopes-141", 2], ["skmei-sport-digital-watch", 1], ["braided-usb-c-cable", 3], ["clover-necklace-set", 1]], daysAgo: 7, deliveryFee: 0,
  },
  {
    ref: "KH26032210027", userEmail: "sara.khan@example.com", name: "Sara Khan", email: "sara.khan@example.com",
    phone: "03219876543", city: "Karachi", province: "Sindh", line1: "Flat 3-B, Clifton Block 2",
    status: "CONFIRMED", paymentMethod: "COD", paymentStatus: "PENDING",
    items: [["anne-klein-bracelet-watch", 1]], daysAgo: 4, deliveryFee: 0,
  },
  {
    ref: "KH26032410028", userEmail: "ali.hassan@example.com", name: "Ali Hassan", email: "ali.hassan@example.com",
    phone: "03001234567", city: "Lahore", province: "Punjab", line1: "Office No 45, 3rd Floor, Tech Tower, Johar Town",
    status: "PENDING", paymentMethod: "COD", paymentStatus: "PENDING",
    items: [["xiaomi-smart-band-8", 1], ["rose-gold-matching-pair", 1]], daysAgo: 2, deliveryFee: 0,
  },
  {
    ref: "KH26032510029", userEmail: null, name: "Ayesha Malik", email: "ayesha.malik@example.com",
    phone: "03009988776", city: "Multan", province: "Punjab", line1: "Shah Rukn-e-Alam Colony, Block A",
    status: "CANCELLED", paymentMethod: "COD", paymentStatus: "PENDING",
    items: [["realme-buds-t300", 1]], daysAgo: 1, deliveryFee: 200,
  },
];

export async function runSeed(
  db: PrismaClient,
  env: NodeJS.ProcessEnv,
): Promise<SeedSummary> {
  const target = checkSeedTarget(env);
  if (!target.ok) {
    throw new Error(`Seed refused: ${target.reason}`);
  }

  const summary: SeedSummary = {
    settingsPresent: 0,
    categoriesPresent: 0,
    productsPresent: 0,
    couponsPresent: 0,
    bannersCreated: 0,
    promotionsCreated: 0,
    ordersCreated: 0,
    ordersAlreadyPresent: 0,
    usersCreated: [],
    usersAlreadyPresent: [],
    usersSkippedNoPassword: [],
  };

  // 1) Settings — create if missing, never overwrite (an admin may have
  // changed these through the admin panel).
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.storeSetting.upsert({
      where: { key },
      update: {},
      create: { key, value },
    });
    summary.settingsPresent += 1;
  }

  // 2) Categories — upsert by slug, parents first.
  const catIds = new Map<string, string>();
  for (const parent of PARENT_CATEGORIES) {
    const c = await db.category.upsert({
      where: { slug: parent.slug },
      update: {},
      create: {
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
    const c = await db.category.upsert({
      where: { slug: leaf.slug },
      update: {},
      create: {
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
  summary.categoriesPresent = PARENT_CATEGORIES.length + LEAF_CATEGORIES.length;

  // 3) Products + images + inventory — upsert by slug; an existing product
  // (and its stock level) is left untouched.
  let n = 0;
  for (const p of PRODUCTS) {
    const created = await db.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
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
    const imageUrl = `/images/products/${p.slug}.png`;
    const existingImage = await db.productImage.findFirst({
      where: { productId: created.id, url: imageUrl },
      select: { id: true },
    });
    if (!existingImage) {
      await db.productImage.create({
        data: { productId: created.id, url: imageUrl, alt: p.name, sortOrder: 0 },
      });
    }
    await db.inventory.upsert({
      where: { productId: created.id },
      update: {},
      create: { productId: created.id, quantity: p.stock, lowStockThreshold: 5 },
    });
    n++;
  }
  summary.productsPresent = n;

  // 4) Users — create only if the account does not exist AND a valid
  // password was supplied for it. An existing account is never touched
  // (its password is never reset by a re-run).
  const userIds = new Map<string, string>();
  for (const spec of SEED_ACCOUNTS) {
    const existing = await db.user.findUnique({ where: { email: spec.email } });
    if (existing) {
      summary.usersAlreadyPresent.push(spec.email);
      userIds.set(spec.email, existing.id);
      continue;
    }
    const checked = validateSeedPassword(env[spec.passwordEnvVar], spec.passwordEnvVar);
    if (checked.status === "missing") {
      summary.usersSkippedNoPassword.push(spec.email);
      continue;
    }
    if (checked.status === "invalid") {
      throw new Error(`Seed refused: ${checked.reason}`);
    }
    const passwordHash = await bcrypt.hash(env[spec.passwordEnvVar]!, 12);
    const created = await db.user.create({
      data: {
        email: spec.email,
        name: spec.name,
        passwordHash,
        role: spec.role,
        phone: spec.phone,
        emailVerified: new Date(),
      },
    });
    summary.usersCreated.push(spec.email);
    userIds.set(spec.email, created.id);
  }

  // 5) Addresses — create if missing, for whichever seeded accounts exist.
  const seedAddresses = [
    {
      userEmail: "ali.hassan@example.com",
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
      userEmail: "ali.hassan@example.com",
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
      userEmail: "sara.khan@example.com",
      label: "Home",
      fullName: "Sara Khan",
      phone: "03219876543",
      line1: "Flat 3-B, Clifton Block 2",
      city: "Karachi",
      province: "Sindh",
      postalCode: "75600",
      isDefault: true,
    },
  ];
  for (const a of seedAddresses) {
    const userId = userIds.get(a.userEmail);
    if (!userId) continue;
    const existing = await db.address.findFirst({
      where: { userId, label: a.label },
      select: { id: true },
    });
    if (existing) continue;
    await db.address.create({
      data: {
        userId,
        label: a.label,
        fullName: a.fullName,
        phone: a.phone,
        line1: a.line1,
        city: a.city,
        province: a.province,
        postalCode: a.postalCode,
        isDefault: a.isDefault,
      },
    });
  }

  // 6) Banners — create if missing (matched by title + placement).
  const banners = [
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
  ];
  for (const b of banners) {
    const existing = await db.banner.findFirst({
      where: { title: b.title, placement: b.placement },
      select: { id: true },
    });
    if (existing) continue;
    await db.banner.create({ data: b });
    summary.bannersCreated += 1;
  }

  // 7) Coupons — upsert by code, never resetting usedCount.
  const coupons = [
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
  ];
  for (const c of coupons) {
    await db.coupon.upsert({
      where: { code: c.code },
      update: {},
      create: c,
    });
    summary.couponsPresent += 1;
  }

  // 8) Promotions — create if missing (matched by title).
  const existingPromo = await db.promotion.findFirst({
    where: { title: "Mid-Season Sale" },
    select: { id: true },
  });
  if (!existingPromo) {
    await db.promotion.create({
      data: {
        title: "Mid-Season Sale",
        description: "Up to 20% off on selected watches and earbuds. Limited time only.",
        type: "PERCENT",
        value: 20,
        isActive: true,
      },
    });
    summary.promotionsCreated += 1;
  }

  // 9) Demo orders — create only if the reference does not already exist.
  // Orders for accounts that were not created are skipped; guest orders are
  // always created. Existing orders (real or demo) are never touched.
  const products = await db.product.findMany({
    include: { images: { take: 1, orderBy: { sortOrder: "asc" } } },
  });
  const bySlug = new Map(products.map((p) => [p.slug, p]));
  for (const o of DEMO_ORDERS) {
    const existing = await db.order.findUnique({
      where: { reference: o.ref },
      select: { id: true },
    });
    if (existing) {
      summary.ordersAlreadyPresent += 1;
      continue;
    }
    const userId = o.userEmail ? userIds.get(o.userEmail) : null;
    if (o.userEmail && !userId) continue;
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
        userId,
        isGuest: userId === null,
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
    summary.ordersCreated += 1;
  }

  // 10) Wishlist sample for Ali — create if missing.
  const aliId = userIds.get("ali.hassan@example.com");
  if (aliId) {
    for (const slug of ["clover-necklace-set", "fitbit-inspire-3"]) {
      const product = bySlug.get(slug);
      if (!product) continue;
      await db.wishlistItem.upsert({
        where: { userId_productId: { userId: aliId, productId: product.id } },
        update: {},
        create: { userId: aliId, productId: product.id },
      });
    }
  }

  return summary;
}
