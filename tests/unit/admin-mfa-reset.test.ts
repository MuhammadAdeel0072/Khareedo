// Admin MFA break-glass reset tests. The reset logic is pure (env/argv
// in, store in) — no database, no SUPABASE_POSTGRES_URL, no encryption
// key is needed here. The store is mocked; the integration test
// (tests/unit/integration.admin-mfa-reset.test.ts) exercises the same
// function against real Prisma on a disposable SQLite database.
import { describe, expect, it, vi } from "vitest";
import {
  MFA_RESET_AUDIT_ACTION,
  checkResetOptIn,
  checkSupabasePostgresTarget,
  parseResetArgs,
  resetAdminMfa,
  resolveResetRunMode,
  type MfaResetStore,
} from "@/lib/admin-mfa-reset";

// Fictional Supabase project ref for fixtures — deliberately not the
// real project ref, and "password" here is a dummy value, never a
// credential. Only the URL *shape* matters to the target guard.
const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
const POOLER_URL =
  "postgres://postgres.abcdefghijklmnopqrst:password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
const DIRECT_URL =
  "postgres://postgres:password@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";

function baseEnv(): Record<string, string | undefined> {
  return { SUPABASE_POSTGRES_URL: POOLER_URL, NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL };
}

type MockStore = MfaResetStore & {
  __mocks: {
    userFindMany: ReturnType<typeof vi.fn>;
    mfaDelete: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
};

function makeStore(overrides: Partial<{
  users: { id: string; email: string; role: string }[];
  mfa: { id: string; userId: string } | null;
  codes: { usedAt: Date | null }[];
}> = {}): MockStore {
  const users = overrides.users ?? [
    { id: "admin-1", email: "admin@khareedo.pk", role: "ADMIN" },
  ];
  const mfa = overrides.mfa === undefined ? { id: "mfa-1", userId: "admin-1" } : overrides.mfa;
  const codes = overrides.codes ?? [
    { usedAt: null },
    { usedAt: null },
    { usedAt: new Date() },
  ];
  const userFindMany = vi.fn(async () => users);
  const mfaDelete = vi.fn(async () => ({ id: "mfa-1" }));
  const auditCreate = vi.fn(async () => ({}));
  const tx = {
    user: { findMany: userFindMany },
    adminMfa: {
      findUnique: vi.fn(async () => mfa),
      delete: mfaDelete,
    },
    adminMfaRecoveryCode: { findMany: vi.fn(async () => codes) },
    adminAuditLog: { create: auditCreate },
    $transaction: vi.fn(async () => ({})),
  } as unknown as MfaResetStore;
  const store: MockStore = {
    user: { findMany: userFindMany },
    adminMfa: {
      findUnique: vi.fn(async () => mfa),
      delete: mfaDelete,
    },
    adminMfaRecoveryCode: { findMany: vi.fn(async () => codes) },
    adminAuditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: MfaResetStore) => Promise<unknown>) => fn(tx)) as unknown as MfaResetStore["$transaction"],
    __mocks: { userFindMany, mfaDelete, auditCreate },
  };
  return store;
}

describe("checkSupabasePostgresTarget", () => {
  it("accepts a Supabase pooler URL matching the configured project", () => {
    const result = checkSupabasePostgresTarget(baseEnv());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe("aws-0-eu-central-1.pooler.supabase.com");
      expect(result.projectRef).toBe("abcdefghijklmnopqrst");
    }
  });

  it("accepts a direct Supabase host matching the configured project", () => {
    const result = checkSupabasePostgresTarget({
      SUPABASE_POSTGRES_URL: DIRECT_URL,
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a missing SUPABASE_POSTGRES_URL instead of guessing a target", () => {
    expect(checkSupabasePostgresTarget({ NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL }).ok).toBe(false);
  });

  it("refuses a SQLite file: URL — the local database is never a reset target", () => {
    const result = checkSupabasePostgresTarget({
      SUPABASE_POSTGRES_URL: "file:./dev.db",
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/SQLite/);
  });

  it("refuses a loopback PostgreSQL URL", () => {
    const result = checkSupabasePostgresTarget({
      SUPABASE_POSTGRES_URL: "postgres://postgres:password@localhost:5432/khareedo",
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a non-Supabase remote host", () => {
    const result = checkSupabasePostgresTarget({
      SUPABASE_POSTGRES_URL: "postgres://user:pass@db.example.com:5432/khareedo",
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses when the URL does not match the configured Supabase project", () => {
    const result = checkSupabasePostgresTarget({
      SUPABASE_POSTGRES_URL:
        "postgres://postgres.otherproject:password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match/);
  });

  it("refuses when NEXT_PUBLIC_SUPABASE_URL is missing (project cannot be verified)", () => {
    expect(
      checkSupabasePostgresTarget({ SUPABASE_POSTGRES_URL: POOLER_URL }).ok,
    ).toBe(false);
  });

  it("never echoes the connection URL (credentials) in a refusal", () => {
    const result = checkSupabasePostgresTarget({
      SUPABASE_POSTGRES_URL: "file:./dev.db",
      NEXT_PUBLIC_SUPABASE_URL: PROJECT_URL,
    });
    if (!result.ok) expect(result.reason).not.toContain("dev.db");
  });
});

describe("checkResetOptIn and run mode", () => {
  it("requires ADMIN_MFA_RESET_ALLOW=1 exactly", () => {
    expect(checkResetOptIn({ ADMIN_MFA_RESET_ALLOW: "1" }).ok).toBe(true);
    expect(checkResetOptIn({}).ok).toBe(false);
    expect(checkResetOptIn({ ADMIN_MFA_RESET_ALLOW: "true" }).ok).toBe(false);
    expect(checkResetOptIn({ ADMIN_MFA_RESET_ALLOW: "0" }).ok).toBe(false);
  });

  it("defaults to dry-run and refuses --apply together with --dry-run", () => {
    expect(resolveResetRunMode([])).toEqual({ ok: true, mode: "dry-run" });
    expect(resolveResetRunMode(["--apply"])).toEqual({ ok: true, mode: "apply" });
    expect(resolveResetRunMode(["--apply", "--dry-run"]).ok).toBe(false);
  });

  it("parses --email in both forms and --confirm", () => {
    expect(parseResetArgs(["--email", "admin@khareedo.pk", "--confirm"])).toEqual({
      email: "admin@khareedo.pk",
      confirm: true,
    });
    expect(parseResetArgs(["--email=admin@khareedo.pk"])).toEqual({
      email: "admin@khareedo.pk",
      confirm: false,
    });
  });
});

describe("resetAdminMfa", () => {
  it("refuses when the admin account does not exist", async () => {
    const store = makeStore({ users: [] });
    const result = await resetAdminMfa({ store, email: "admin@khareedo.pk", dryRun: false });
    expect(result).toEqual({
      status: "refused",
      reason: 'No account exists for email "admin@khareedo.pk"; refusing.',
    });
    expect(store.adminMfa.delete).not.toHaveBeenCalled();
    expect(store.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it("refuses when more than one account matches (ambiguous)", async () => {
    const store = makeStore({
      users: [
        { id: "a-1", email: "admin@khareedo.pk", role: "ADMIN" },
        { id: "a-2", email: "admin@khareedo.pk", role: "ADMIN" },
      ],
    });
    const result = await resetAdminMfa({ store, email: "admin@khareedo.pk", dryRun: false });
    expect(result.status).toBe("refused");
    expect(store.adminMfa.delete).not.toHaveBeenCalled();
  });

  it("refuses a non-admin account", async () => {
    const store = makeStore({
      users: [{ id: "c-1", email: "customer@example.com", role: "CUSTOMER" }],
    });
    const result = await resetAdminMfa({ store, email: "customer@example.com", dryRun: false });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/not an admin/);
    expect(store.adminMfa.delete).not.toHaveBeenCalled();
  });

  it("refuses when the admin has no MFA enrollment (nothing to reset)", async () => {
    const store = makeStore({ mfa: null });
    const result = await resetAdminMfa({ store, email: "admin@khareedo.pk", dryRun: false });
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toMatch(/no MFA enrollment/);
    expect(store.adminMfa.delete).not.toHaveBeenCalled();
  });

  it("dry-run reports what would be deleted and writes nothing", async () => {
    const store = makeStore();
    const result = await resetAdminMfa({ store, email: "ADMIN@khareedo.pk", dryRun: true });
    expect(result).toEqual({
      status: "dry-run",
      email: "admin@khareedo.pk",
      userId: "admin-1",
      mfaId: "mfa-1",
      recoveryCodesTotal: 3,
      recoveryCodesUnused: 2,
    });
    expect(store.adminMfa.delete).not.toHaveBeenCalled();
    expect(store.adminAuditLog.create).not.toHaveBeenCalled();
    expect(store.__mocks.mfaDelete).not.toHaveBeenCalled();
  });

  it("apply deletes only the MFA row and records an audit event in one transaction", async () => {
    const store = makeStore();
    const result = await resetAdminMfa({ store, email: "admin@khareedo.pk", dryRun: false });
    expect(result).toEqual({
      status: "reset",
      email: "admin@khareedo.pk",
      userId: "admin-1",
      mfaId: "mfa-1",
      recoveryCodesDeleted: 3,
      auditAction: MFA_RESET_AUDIT_ACTION,
    });
    expect(store.$transaction).toHaveBeenCalledTimes(1);
    expect(store.__mocks.mfaDelete).toHaveBeenCalledWith({ where: { userId: "admin-1" } });
    expect(store.__mocks.auditCreate).toHaveBeenCalledTimes(1);
    const auditCall = store.__mocks.auditCreate.mock.calls[0][0];
    expect(auditCall.data.action).toBe("admin.mfa.reset");
    expect(auditCall.data.adminUserId).toBeNull();
    expect(auditCall.data.targetType).toBe("AdminMfa");
    expect(auditCall.data.targetId).toBe("admin-1");
    // The audit metadata carries no secret material: only the email, a
    // fixed reason, the method, and a count of deleted codes.
    const metadata = JSON.stringify(auditCall.data.metadata ?? {});
    expect(metadata).not.toMatch(/secret|password|hash|totp|token/i);
    expect(Object.keys(auditCall.data.metadata ?? {})).toEqual([
      "email",
      "reason",
      "method",
      "codesDeleted",
    ]);
    expect(auditCall.data.metadata).toEqual({
      email: "admin@khareedo.pk",
      reason: "authenticator-and-recovery-codes-lost",
      method: "operator-break-glass",
      codesDeleted: 3,
    });
  });

  it("never exposes secrets in its result", async () => {
    const store = makeStore();
    const result = await resetAdminMfa({ store, email: "admin@khareedo.pk", dryRun: false });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/password|secret|hash|totp|recovery code/i);
    expect(text).not.toContain("postgres://");
  });

  it("normalises the email the same way sign-in does", async () => {
    const store = makeStore();
    await resetAdminMfa({ store, email: "  Admin@Khareedo.PK ", dryRun: true });
    expect(store.user.findMany).toHaveBeenCalledWith({
      where: { email: "admin@khareedo.pk" },
      select: { id: true, email: true, role: true },
    });
  });
});
