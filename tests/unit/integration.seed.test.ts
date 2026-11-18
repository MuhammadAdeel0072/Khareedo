// Integration tests — the guarded seed (PR-06) against a throwaway SQLite
// database. Run with: npm run test:db
//
// These tests exercise the real seed code path (src/lib/seed.ts) and the
// real Prisma layer, and never use the application's configured database.
//
// Passwords used here are test-only values for the disposable database.
// They are not the (removed) demo passwords and grant nothing anywhere else.
import { describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("../../generated/sqlite-client");
  return {
    db: new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ["error"],
    }),
  };
});

import { db } from "@/lib/db";
import type { PrismaClient } from "../../generated/sqlite-client";
import { runSeed } from "@/lib/seed";

// These tests run only through the disposable SQLite test harness.
assertDisposableTestDatabase();

// The mocked @/lib/db is statically typed as the extended Postgres client,
// but at runtime the mock returns the SQLite client on the disposable DB.
// runSeed only ever receives the SQLite client.
const seedDb = db as unknown as PrismaClient;

function hashOf(user: { passwordHash: string | null }): string {
  if (!user.passwordHash) throw new Error("seeded user has no password hash");
  return user.passwordHash;
}

const ADMIN_PASSWORD = "CorrectHorseBatteryStaple1";
const CUSTOMER_PASSWORD = "Tr0ub4dorAndCo2026!";

function seedEnv(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    SEED_ALLOW: "1",
    DATABASE_URL: process.env.DATABASE_URL,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function counts() {
  const [users, products, orders, addresses, coupons] = await Promise.all([
    db.user.count(),
    db.product.count(),
    db.order.count(),
    db.address.count(),
    db.coupon.count(),
  ]);
  return { users, products, orders, addresses, coupons };
}

describe("guarded seed", () => {
  it("refuses without the explicit opt-in", async () => {
    await expect(runSeed(seedDb, seedEnv({ SEED_ALLOW: undefined }))).rejects.toThrow(
      /SEED_ALLOW=1/,
    );
    await expect(runSeed(seedDb, seedEnv({ SEED_ALLOW: "yes" }))).rejects.toThrow(
      /SEED_ALLOW=1/,
    );
    expect(await db.product.count()).toBe(0);
  });

  it("refuses in production", async () => {
    await expect(runSeed(seedDb, seedEnv({ NODE_ENV: "production" }))).rejects.toThrow(
      /production/i,
    );
    expect(await db.product.count()).toBe(0);
  });

  it("refuses a non-SQLite database target", async () => {
    await expect(
      runSeed(
        seedDb,
        seedEnv({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres" }),
      ),
    ).rejects.toThrow(/file:/);
    expect(await db.product.count()).toBe(0);
  });

  it("refuses a published demo password", async () => {
    // "Admin@123" itself is short, so it would fail the length rule first;
    // a 12-character variant reaches the denylist rule.
    await expect(
      runSeed(seedDb, seedEnv({ SEED_ADMIN_PASSWORD: "Admin@123456" })),
    ).rejects.toThrow(/published demo password/);
    // The refusal happens at the first account, before any user is created.
    expect(await db.user.count()).toBe(0);
  });

  it("seeds the catalog and creates no accounts without passwords", async () => {
    const summary = await runSeed(seedDb, seedEnv());
    expect(summary.productsPresent).toBe(51);
    expect(summary.categoriesPresent).toBe(15);
    expect(summary.usersCreated).toEqual([]);
    expect(summary.usersSkippedNoPassword).toEqual([
      "admin@khareedo.pk",
      "ali.hassan@example.com",
      "sara.khan@example.com",
    ]);
    // Only the guest demo orders are created — the account-linked ones need
    // their accounts to exist.
    expect(await counts()).toEqual({
      users: 0,
      products: 51,
      orders: 3,
      addresses: 0,
      coupons: 3,
    });
  });

  it("creates accounts with valid env passwords — never with the old ones", async () => {
    const summary = await runSeed(
      seedDb,
      seedEnv({
        SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
        SEED_CUSTOMER_PASSWORD: CUSTOMER_PASSWORD,
      }),
    );
    expect(summary.usersCreated).toEqual([
      "admin@khareedo.pk",
      "ali.hassan@example.com",
      "sara.khan@example.com",
    ]);
    expect(await counts()).toEqual({
      users: 3,
      products: 51,
      orders: 9,
      addresses: 3,
      coupons: 3,
    });

    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@khareedo.pk" } });
    expect(admin.role).toBe("ADMIN");
    expect(await bcrypt.compare(ADMIN_PASSWORD, hashOf(admin))).toBe(true);
    expect(await bcrypt.compare("Admin@123", hashOf(admin))).toBe(false);

    const ali = await db.user.findUniqueOrThrow({
      where: { email: "ali.hassan@example.com" },
    });
    expect(ali.role).toBe("CUSTOMER");
    expect(await bcrypt.compare(CUSTOMER_PASSWORD, hashOf(ali))).toBe(true);
    expect(await bcrypt.compare("Customer@123", hashOf(ali))).toBe(false);
  });

  it("a re-run changes nothing — existing rows are never overwritten", async () => {
    // Mutate seeded rows first: a re-run must preserve the mutations.
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@khareedo.pk" } });
    const rotatedHash = await bcrypt.hash("OperatorRotatedPass77", 12);
    await db.user.update({
      where: { id: admin.id },
      data: { name: "Changed Name", passwordHash: rotatedHash },
    });
    const order = await db.order.findUniqueOrThrow({ where: { reference: "KH26030110021" } });
    await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    const product = await db.product.findUniqueOrThrow({ where: { slug: "casio-mens-analog-watch" } });
    await db.product.update({ where: { id: product.id }, data: { price: 12345 } });
    await db.coupon.update({ where: { code: "EID20" }, data: { usedCount: 7 } });

    const before = await counts();
    const summary = await runSeed(
      seedDb,
      seedEnv({
        SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
        SEED_CUSTOMER_PASSWORD: CUSTOMER_PASSWORD,
      }),
    );
    expect(summary.usersCreated).toEqual([]);
    expect(summary.usersAlreadyPresent).toEqual([
      "admin@khareedo.pk",
      "ali.hassan@example.com",
      "sara.khan@example.com",
    ]);
    expect(summary.ordersCreated).toBe(0);
    expect(await counts()).toEqual(before);

    const adminAfter = await db.user.findUniqueOrThrow({ where: { email: "admin@khareedo.pk" } });
    expect(adminAfter.name).toBe("Changed Name");
    expect(adminAfter.passwordHash).toBe(rotatedHash);
    expect(await bcrypt.compare("OperatorRotatedPass77", hashOf(adminAfter))).toBe(true);
    expect(await bcrypt.compare(ADMIN_PASSWORD, hashOf(adminAfter))).toBe(false);

    const orderAfter = await db.order.findUniqueOrThrow({ where: { reference: "KH26030110021" } });
    expect(orderAfter.status).toBe("CANCELLED");
    const productAfter = await db.product.findUniqueOrThrow({
      where: { slug: "casio-mens-analog-watch" },
    });
    expect(productAfter.price).toBe(12345);
    const couponAfter = await db.coupon.findUniqueOrThrow({ where: { code: "EID20" } });
    expect(couponAfter.usedCount).toBe(7);
  });
});
