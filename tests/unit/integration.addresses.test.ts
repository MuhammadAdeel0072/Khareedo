// Integration test — address CRUD invariants (Phase 3, chunk 12 follow-up B)
// against the real Prisma layer on a disposable SQLite database. Run with:
// npm run test:db
//
// Covers, with the real service + route handlers:
// - exactly-one-default enforced server-side: the first address is default
//   atomically; setting a default clears the others; deleting the default
//   promotes the oldest remaining address in the same transaction and
//   reports it as promotedId (the client-side second PUT is gone);
// - ownership-scoped writes: update/delete of another user's address is a
//   404 and writes nothing;
// - PUT and DELETE both return 404 for a missing address (PUT used to
//   return 422 for the same condition);
// - per-user cap of 10 addresses, enforced inside the create transaction;
// - province validated server-side against the shared list;
// - concurrent first-address creates still leave exactly one default.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableTestDatabase } from "../helpers/disposable-sqlite.mjs";

const sessionUser = vi.hoisted(() => ({ id: "" }));

vi.mock("@/lib/auth-guard", () => ({
  getSessionUser: async () => (sessionUser.id ? { id: sessionUser.id } : null),
  requireUser: async () => {
    if (!sessionUser.id) throw new Error("Unauthorized");
    return { id: sessionUser.id };
  },
}));

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
import {
  createAddress,
  updateAddress,
  deleteAddress,
  listAddresses,
  MAX_ADDRESSES_PER_USER,
} from "@/services/users.service";
import { POST as createRoute } from "@/app/api/account/addresses/route";
import { PUT as updateRoute, DELETE as deleteRoute } from "@/app/api/account/addresses/[id]/route";

assertDisposableTestDatabase();

const created = { users: [] as string[] };

function addressInput(overrides: Record<string, unknown> = {}) {
  return {
    label: "Home",
    fullName: "Adeel Khan",
    phone: "03001234567",
    line1: "123 Main Street, Gulberg",
    line2: "",
    city: "Lahore",
    province: "Punjab",
    postalCode: "54000",
    isDefault: false,
    ...overrides,
  };
}

async function seedUser() {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
  created.users.push(user.id);
  return user;
}

async function mustCreate(userId: string, input: Record<string, unknown> = {}) {
  const result = await createAddress(userId, addressInput(input));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createAddress failed unexpectedly");
  return result.address;
}

async function defaultsFor(userId: string) {
  const rows = await listAddresses(userId);
  return rows.filter((a) => a.isDefault);
}

beforeEach(() => {
  sessionUser.id = "";
});

afterAll(async () => {
  await db.address.deleteMany({ where: { userId: { in: created.users } } });
  await db.user.deleteMany({ where: { id: { in: created.users } } });
  await db.$disconnect();
});

describe("address defaults (exactly-one-default, server-side)", () => {
  it("makes the first address the default atomically", async () => {
    const user = await seedUser();
    const address = await mustCreate(user.id);
    expect(address.isDefault).toBe(true);
    expect(await defaultsFor(user.id)).toHaveLength(1);
  });

  it("setting a default clears the others, so exactly one default holds", async () => {
    const user = await seedUser();
    const first = await mustCreate(user.id, { label: "Home" });
    const second = await mustCreate(user.id, { label: "Office" });
    expect(second.isDefault).toBe(false);

    const updated = await updateAddress(user.id, second.id, addressInput({ label: "Office", isDefault: true }));
    expect(updated.ok).toBe(true);
    const defaults = await defaultsFor(user.id);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.id);
    expect((await db.address.findUniqueOrThrow({ where: { id: first.id } })).isDefault).toBe(false);
  });

  it("deleting the default promotes the oldest remaining and reports it", async () => {
    const user = await seedUser();
    const first = await mustCreate(user.id, { label: "Home" });
    const second = await mustCreate(user.id, { label: "Office" });
    const third = await mustCreate(user.id, { label: "Parents" });
    // Make the ordering unambiguous: second is strictly older than third.
    await db.address.update({
      where: { id: second.id },
      data: { createdAt: new Date(Date.now() - 1000) },
    });

    const result = await deleteAddress(user.id, first.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("deleteAddress failed unexpectedly");
    expect(result.promotedId).toBe(second.id);

    const defaults = await defaultsFor(user.id);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.id);
    expect(await db.address.findUnique({ where: { id: third.id } })).not.toBeNull();
  });

  it("deleting the last address leaves no default behind", async () => {
    const user = await seedUser();
    const only = await mustCreate(user.id);
    const result = await deleteAddress(user.id, only.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("deleteAddress failed unexpectedly");
    expect(result.promotedId).toBeNull();
    expect(await listAddresses(user.id)).toHaveLength(0);
  });

  it("concurrent first-address creates leave exactly one default", async () => {
    const user = await seedUser();
    const [a, b] = await Promise.all([
      createAddress(user.id, addressInput({ label: "A" })),
      createAddress(user.id, addressInput({ label: "B" })),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await listAddresses(user.id)).toHaveLength(2);
    expect(await defaultsFor(user.id)).toHaveLength(1);
  });
});

describe("address ownership + not-found", () => {
  it("update/delete of another user's address is a 404 and writes nothing", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const address = await mustCreate(owner.id, { label: "Home" });

    const updated = await updateAddress(other.id, address.id, addressInput({ label: "Hijacked" }));
    expect(updated).toMatchObject({ ok: false, notFound: true });
    expect((await db.address.findUniqueOrThrow({ where: { id: address.id } })).label).toBe("Home");

    const deleted = await deleteAddress(other.id, address.id);
    expect(deleted).toMatchObject({ ok: false, notFound: true });
    expect(await db.address.findUnique({ where: { id: address.id } })).not.toBeNull();
  });

  it("PUT and DELETE routes both return 404 for a missing address", async () => {
    const user = await seedUser();
    sessionUser.id = user.id;

    const putRes = await updateRoute(
      new Request("http://localhost/api/account/addresses/missing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addressInput()),
      }),
      { params: Promise.resolve({ id: "missing" }) }
    );
    expect(putRes.status).toBe(404);
    expect(await putRes.json()).toMatchObject({ error: "Address not found." });

    const deleteRes = await deleteRoute(
      new Request("http://localhost/api/account/addresses/missing", { method: "DELETE" }),
      { params: Promise.resolve({ id: "missing" }) }
    );
    expect(deleteRes.status).toBe(404);
  });

  it("PUT route updates the caller's own address", async () => {
    const user = await seedUser();
    sessionUser.id = user.id;
    const address = await mustCreate(user.id, { label: "Home" });

    const res = await updateRoute(
      new Request(`http://localhost/api/account/addresses/${address.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addressInput({ label: "Renamed" })),
      }),
      { params: Promise.resolve({ id: address.id }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { address: { label: string } };
    expect(body.address.label).toBe("Renamed");
  });
});

describe("address cap + province validation", () => {
  it(`rejects the ${MAX_ADDRESSES_PER_USER + 1}th address (cap ${MAX_ADDRESSES_PER_USER})`, async () => {
    expect(MAX_ADDRESSES_PER_USER).toBe(10);
    const user = await seedUser();
    for (let i = 0; i < MAX_ADDRESSES_PER_USER; i++) {
      await mustCreate(user.id, { label: `Address ${i}` });
    }
    const over = await createAddress(user.id, addressInput({ label: "One too many" }));
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("cap was not enforced");
    expect(over.errors?._).toContain("up to 10 addresses");
    expect(await listAddresses(user.id)).toHaveLength(MAX_ADDRESSES_PER_USER);

    // The cap surfaces through the route as a 422 with the same message.
    sessionUser.id = user.id;
    const res = await createRoute(
      new Request("http://localhost/api/account/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addressInput({ label: "One too many" })),
      })
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: { _?: string } };
    expect(body.errors._).toContain("up to 10 addresses");
  });

  it("rejects an out-of-list province on create and update", async () => {
    const user = await seedUser();
    const bad = await createAddress(user.id, addressInput({ province: "Nowhere" }));
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("province validation did not reject");
    expect(bad.errors).toMatchObject({ province: expect.any(String) });

    const good = await mustCreate(user.id);
    const badUpdate = await updateAddress(user.id, good.id, addressInput({ province: "KPK" }));
    expect(badUpdate.ok).toBe(false);
    if (badUpdate.ok) throw new Error("province validation did not reject the update");
    expect(badUpdate.errors).toMatchObject({ province: expect.any(String) });
    expect((await db.address.findUniqueOrThrow({ where: { id: good.id } })).province).toBe("Punjab");
  });
});
