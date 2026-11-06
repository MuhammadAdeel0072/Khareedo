// Users service — registration, profile, addresses (FR-02, FR-05, FR-06).
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { registerSchema, profileSchema, addressSchema, fieldErrors } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { EmailDeliveryNotConfiguredError, isEmailDeliveryConfigured } from "@/services/email.service";
import { sendRegistrationVerification } from "@/services/email-verification.service";
import { findUserByEmail } from "@/services/auth-users.service";
import { withPerformanceTiming } from "@/lib/performance-timing";

export async function registerUser(input: unknown) {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, errors: fieldErrors(parsed.error) };
  }
  const { name, email, password } = parsed.data;
  if (!isEmailDeliveryConfigured()) throw new EmailDeliveryNotConfiguredError();

  const existing = await findUserByEmail(email);
  if (existing?.passwordHash && !existing.emailVerified) {
    await sendRegistrationVerification({
      id: existing.id,
      email: existing.email,
      name: existing.name,
    });
    return { ok: true as const };
  }
  if (existing) return { ok: true as const };

  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try {
    user = await db.user.create({
      data: { name, email, passwordHash, role: "CUSTOMER" },
      select: { id: true, email: true, name: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: true as const };
    }
    throw error;
  }
  await sendRegistrationVerification(user);
  return { ok: true as const };
}

export async function updateProfile(userId: string, input: unknown) {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, errors: fieldErrors(parsed.error) };
  }
  const { name, phone, image } = parsed.data;
  await db.user.update({
    where: { id: userId },
    data: { name, phone: phone || null, ...(image ? { image } : {}) },
  });
  return { ok: true as const };
}

export async function getUserProfile(userId: string) {
  return db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, phone: true, image: true, createdAt: true },
  });
}

export async function adminListCustomerSummaries(limit = 100) {
  const customers = await db.user.findMany({
    where: { role: "CUSTOMER" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      createdAt: true,
      _count: { select: { addresses: true } },
    },
  });

  if (customers.length === 0) return [];

  const orderTotals = await db.order.groupBy({
    by: ["userId"],
    where: {
      userId: { in: customers.map((customer) => customer.id) },
      status: { not: "CANCELLED" },
    },
    _count: { _all: true },
    _sum: { total: true },
  });
  const totalsByUser = new Map<string, { orders: number; totalSpent: number }>();
  for (const row of orderTotals) {
    if (row.userId) {
      totalsByUser.set(row.userId, {
        orders: row._count._all,
        totalSpent: row._sum.total ?? 0,
      });
    }
  }

  return customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    createdAt: customer.createdAt,
    orderCount: totalsByUser.get(customer.id)?.orders ?? 0,
    totalSpent: totalsByUser.get(customer.id)?.totalSpent ?? 0,
    addressCount: customer._count.addresses,
  }));
}

// ─── Addresses (FR-05) ───

export async function listAddresses(userId: string) {
  return db.address.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

export async function createAddress(userId: string, input: unknown) {
  return withPerformanceTiming("address.create", async () => {
  const parsed = addressSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, errors: fieldErrors(parsed.error) };
  const data = parsed.data;
  const count = await db.address.count({ where: { userId } });
  return withPerformanceTiming("address.create.transaction", () =>
    db.$transaction(async (tx) => {
      if (data.isDefault || count === 0) {
        await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      }
      const address = await tx.address.create({
        data: {
          userId,
          label: data.label,
          fullName: data.fullName,
          phone: data.phone,
          line1: data.line1,
          line2: data.line2 || null,
          city: data.city,
          province: data.province,
          postalCode: data.postalCode || null,
          isDefault: data.isDefault || count === 0,
        },
      });
      return { ok: true as const, address };
    })
  );
  });
}

export async function updateAddress(userId: string, addressId: string, input: unknown) {
  const parsed = addressSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, errors: fieldErrors(parsed.error) };
  const existing = await db.address.findFirst({ where: { id: addressId, userId } });
  if (!existing) return { ok: false as const, errors: { _: "Address not found" } };
  const data = parsed.data;
  return db.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }
    const address = await tx.address.update({
      where: { id: addressId },
      data: {
        label: data.label,
        fullName: data.fullName,
        phone: data.phone,
        line1: data.line1,
        line2: data.line2 || null,
        city: data.city,
        province: data.province,
        postalCode: data.postalCode || null,
        isDefault: data.isDefault,
      },
    });
    return { ok: true as const, address };
  });
}

export async function deleteAddress(userId: string, addressId: string) {
  const existing = await db.address.findFirst({ where: { id: addressId, userId } });
  if (!existing) return { ok: false as const };
  await db.address.delete({ where: { id: addressId } });
  return { ok: true as const };
}

export { rateLimit };
