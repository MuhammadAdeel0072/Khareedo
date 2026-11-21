// Users service — registration, profile, addresses (FR-02, FR-05, FR-06).
import { Prisma } from "../../generated/postgres-client";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { registerSchema, profileSchema, addressSchema, fieldErrors } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { sendRegistrationVerification } from "@/services/email-verification.service";
import { findUserByEmail } from "@/services/auth-users.service";
import { withPerformanceTiming } from "@/lib/performance-timing";
import { ADMIN_PAGE_SIZE } from "@/lib/constants";

export async function registerUser(input: unknown) {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, errors: fieldErrors(parsed.error) };
  }
  const { name, email, password, callbackUrl } = parsed.data;
  // No SMTP-configuration gate here (Phase 3 Chunk 7, M-24): registration
  // only enqueues a verification email in the outbox, so it must succeed
  // whether or not SMTP is currently reachable. A misconfigured or down
  // SMTP host shows up as a FAILED outbox row in the admin viewer instead
  // of failing the registration.

  const existing = await findUserByEmail(email);
  if (existing?.passwordHash && !existing.emailVerified) {
    await sendRegistrationVerification(
      {
        id: existing.id,
        email: existing.email,
        name: existing.name,
      },
      callbackUrl ?? null
    );
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
  await sendRegistrationVerification(user, callbackUrl ?? null);
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

export interface CustomerSummary {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  createdAt: Date;
  orderCount: number;
  totalSpent: number;
  addressCount: number;
}

/** Admin customer list (FR-45): paginated — the old hard cap of 100 rows
 * silently dropped every customer past the first hundred. */
export async function adminListCustomerSummaries(input: { page?: number; perPage?: number } = {}): Promise<{
  items: CustomerSummary[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}> {
  const page = Math.max(1, Math.floor(input.page ?? 1) || 1);
  // Cap 1000, not 100: the customers export pulls the whole list through
  // this function (getCustomersExportData, limit 1000), and a 100-row cap
  // would silently truncate the export.
  const perPage = Math.min(1000, Math.max(1, Math.floor(input.perPage ?? ADMIN_PAGE_SIZE) || ADMIN_PAGE_SIZE));
  const [customers, total] = await Promise.all([
    db.user.findMany({
      where: { role: "CUSTOMER" },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        _count: { select: { addresses: true } },
      },
    }),
    db.user.count({ where: { role: "CUSTOMER" } }),
  ]);

  if (customers.length === 0) return { items: [], total, page, perPage, pages: Math.ceil(total / perPage) };

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

  return {
    items: customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      createdAt: customer.createdAt,
      orderCount: totalsByUser.get(customer.id)?.orders ?? 0,
      totalSpent: totalsByUser.get(customer.id)?.totalSpent ?? 0,
      addressCount: customer._count.addresses,
    })),
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
  };
}

/** Single customer drill-down for the admin customers list: profile,
 * saved addresses and recent orders with the same totals as the list. */
export async function adminGetCustomerById(id: string) {
  const customer = await db.user.findUnique({
    where: { id, role: "CUSTOMER" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      emailVerified: true,
      createdAt: true,
      addresses: {
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: {
          id: true,
          label: true,
          fullName: true,
          phone: true,
          line1: true,
          line2: true,
          city: true,
          province: true,
          postalCode: true,
          isDefault: true,
          createdAt: true,
        },
      },
      _count: { select: { addresses: true, orders: true } },
    },
  });
  if (!customer) return null;
  const [orders, totals] = await Promise.all([
    db.order.findMany({
      where: { userId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        reference: true,
        status: true,
        paymentMethod: true,
        paymentStatus: true,
        total: true,
        createdAt: true,
        _count: { select: { items: true } },
      },
    }),
    db.order.aggregate({
      where: { userId: id, status: { not: "CANCELLED" } },
      _count: { _all: true },
      _sum: { total: true },
    }),
  ]);
  return {
    ...customer,
    orderCount: totals._count._all,
    totalSpent: totals._sum.total ?? 0,
    orders: orders.map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      total: o.total,
      itemCount: o._count.items,
      createdAt: o.createdAt,
    })),
  };
}

// ─── Addresses (FR-05) ───

// Maximum saved addresses per user (Phase 3, chunk 12 follow-up B).
// No cap convention existed in the codebase; 10 keeps the address book
// usable while bounding unbounded per-user rows. Enforced in
// createAddress, inside the transaction, so the count and the insert
// cannot race.
export const MAX_ADDRESSES_PER_USER = 10;

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
  return withPerformanceTiming("address.create.transaction", () =>
    db.$transaction(async (tx) => {
      // Count inside the transaction (Phase 3, chunk 12 follow-up B):
      // the pre-transaction count raced with concurrent creates, so two
      // first addresses could both be created non-default — or both
      // default. The count, the cap check, the clear-others and the
      // insert are one atomic unit, so exactly one default always holds.
      const count = await tx.address.count({ where: { userId } });
      if (count >= MAX_ADDRESSES_PER_USER) {
        return {
          ok: false as const,
          errors: { _: `You can save up to ${MAX_ADDRESSES_PER_USER} addresses.` },
        };
      }
      const isDefault = data.isDefault || count === 0;
      if (isDefault) {
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
          isDefault,
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
  if (!existing) return { ok: false as const, notFound: true as const };
  const data = parsed.data;
  return db.$transaction(async (tx) => {
    // Ownership check-then-act was not atomic (Phase 3, chunk 12
    // follow-up B): the pre-check above can pass and the row still be
    // deleted or transferred before this write. The write itself is
    // scoped by { id, userId }, and a zero count means the row is gone
    // (or no longer the caller's) — the caller gets a 404, not a write
    // to someone else's address.
    // The scoped write runs FIRST: if it affects zero rows the
    // transaction returns before any write, so a failed update can never
    // commit a half-applied clear-others.
    const updated = await tx.address.updateMany({
      where: { id: addressId, userId },
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
    if (updated.count !== 1) return { ok: false as const, notFound: true as const };
    if (data.isDefault) {
      await tx.address.updateMany({
        where: { userId, id: { not: addressId } },
        data: { isDefault: false },
      });
    }
    const address = await tx.address.findUniqueOrThrow({ where: { id: addressId } });
    return { ok: true as const, address };
  });
}

export async function deleteAddress(userId: string, addressId: string) {
  return db.$transaction(async (tx) => {
    const existing = await tx.address.findFirst({
      where: { id: addressId, userId },
      select: { isDefault: true },
    });
    if (!existing) return { ok: false as const, notFound: true as const };
    // Scoped delete (Phase 3, chunk 12 follow-up B): the write carries
    // the ownership condition, so the check and the delete cannot race.
    const deleted = await tx.address.deleteMany({ where: { id: addressId, userId } });
    if (deleted.count !== 1) return { ok: false as const, notFound: true as const };
    // Exactly-one-default (Phase 3, chunk 12 follow-up B): deleting the
    // default used to be promoted client-side, unchecked — a failed or
    // skipped second request left the user with no default. The server
    // now promotes the oldest remaining address in the same transaction
    // and reports which one, so the client never guesses.
    let promotedId: string | null = null;
    if (existing.isDefault) {
      const next = await tx.address.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (next) {
        await tx.address.updateMany({
          where: { id: next.id, userId },
          data: { isDefault: true },
        });
        promotedId = next.id;
      }
    }
    return { ok: true as const, promotedId };
  });
}

export { rateLimit };
