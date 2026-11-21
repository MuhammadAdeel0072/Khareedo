// Append-only administrator audit log (PR-12).
//
// One row per security-relevant admin action. The application never
// updates or deletes these rows: this service only exposes record + list,
// and there is no update/delete API for them. Pass a transaction client
// to record atomically with the business action — when the business
// operation fails, the audit row rolls back with it, so a failed action
// never produces a false success record.
//
// Metadata must NEVER contain passwords, tokens, secrets, TOTP secrets,
// recovery codes, or payment secrets. sanitizeAuditMetadata strips keys
// matching sensitive patterns before anything is written.
import { db } from "@/lib/db";
import { clientIp } from "@/lib/rate-limit";
import { getPerformanceRequestId } from "@/lib/performance-timing";
import { captureError } from "@/lib/error-monitoring";
import type { SessionUser } from "@/lib/auth-guard";
import type { Prisma } from "../../generated/postgres-client";

/** Stable action names, namespaced by domain. */
export const ADMIN_AUDIT_ACTIONS = {
  AUTH_ADMIN_LOGIN: "admin.auth.login",
  MFA_ENROLLMENT_STARTED: "admin.mfa.enrollment_started",
  MFA_ACTIVATED: "admin.mfa.activated",
  MFA_REPLACEMENT_STARTED: "admin.mfa.replacement_started",
  MFA_REPLACEMENT_ACTIVATED: "admin.mfa.replacement_activated",
  MFA_DISABLED: "admin.mfa.disabled",
  MFA_RECOVERY_CODES_REGENERATED: "admin.mfa.recovery_codes_regenerated",
  PRODUCT_CREATED: "admin.product.created",
  PRODUCT_UPDATED: "admin.product.updated",
  PRODUCT_ARCHIVED: "admin.product.archived",
  PRODUCT_RESTORED: "admin.product.restored",
  REVIEW_APPROVED: "admin.review.approved",
  REVIEW_REJECTED: "admin.review.rejected",
  CATEGORY_CREATED: "admin.category.created",
  CATEGORY_UPDATED: "admin.category.updated",
  CATEGORY_DELETED: "admin.category.deleted",
  INVENTORY_UPDATED: "admin.inventory.updated",
  ORDER_STATUS_CHANGED: "admin.order.status_changed",
  PAYMENT_REFUND_REQUESTED: "admin.payment.refund_requested",
  PAYMENT_MAINTENANCE_RUN: "admin.payment.maintenance_run",
  PAYMENT_REVIEW_HOLD_RESOLVED: "admin.payment.review_hold_resolved",
  EMAIL_OUTBOX_RETRIED: "admin.email.outbox_retried",
  EMAIL_OUTBOX_DELIVERY_RUN: "admin.email.outbox_delivery_run",
  SETTINGS_UPDATED: "admin.settings.updated",
  BANNER_CREATED: "admin.banner.created",
  BANNER_UPDATED: "admin.banner.updated",
  BANNER_DELETED: "admin.banner.deleted",
  COUPON_CREATED: "admin.coupon.created",
  COUPON_UPDATED: "admin.coupon.updated",
  COUPON_DELETED: "admin.coupon.deleted",
  PROMOTION_CREATED: "admin.promotion.created",
  PROMOTION_UPDATED: "admin.promotion.updated",
  PROMOTION_DELETED: "admin.promotion.deleted",
  EXPORT_CREATED: "admin.export.created",
  UPLOAD_CREATED: "admin.upload.created",
  IMPORT_COMPLETED: "admin.import.completed",
} as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[keyof typeof ADMIN_AUDIT_ACTIONS];

/** Who performed the action, and the request it came in on. */
export type AdminAuditContext = {
  adminUserId: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
};

/**
 * Build the audit context from a request and the authenticated admin.
 * The IP comes from clientIp() (first X-Forwarded-For entry) and carries
 * the same trusted-proxy caveat as every other per-IP limit in the app:
 * it is reliable only behind a proxy that overwrites the header.
 * Defensive by design: an audit-context failure must never break the
 * business operation it describes, so every lookup falls back instead
 * of throwing (route tests that mock the rate-limit module, for example,
 * may not provide clientIp at all).
 */
export function adminAuditContext(request: Request, admin: SessionUser): AdminAuditContext {
  let requestId: string | undefined;
  try {
    requestId = getPerformanceRequestId();
  } catch {
    requestId = undefined;
  }
  let ipAddress = "unknown";
  try {
    ipAddress = clientIp(request.headers);
  } catch {
    ipAddress = "unknown";
  }
  let userAgent: string | undefined;
  try {
    userAgent = request.headers.get("user-agent") ?? undefined;
  } catch {
    userAgent = undefined;
  }
  return {
    adminUserId: admin.id,
    requestId,
    ipAddress,
    userAgent,
  };
}

/** JSON value shape for audit metadata (Prisma's InputJsonValue). */
export type AuditJsonValue = Prisma.InputJsonValue;

const SENSITIVE_KEY_PATTERN =
  /password|secret|token|cookie|authorization|totp|recovery|credential|private[_-]?key|api[_-]?key|session/i;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_KEYS = 50;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 20;

function sanitizeValue(value: unknown, depth: number): AuditJsonValue | undefined {
  // Null/undefined carry no audit signal; drop the key rather than storing
  // a JSON null (Prisma's InputJsonValue has no bare null).
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_METADATA_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: AuditJsonValue[] = [];
    for (const item of value.slice(0, MAX_ARRAY_LENGTH)) {
      const cleaned = sanitizeValue(item, depth + 1);
      if (cleaned !== undefined) out.push(cleaned);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: { [key: string]: AuditJsonValue } = {};
    let kept = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (kept >= MAX_METADATA_KEYS) break;
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      const cleaned = sanitizeValue(entry, depth + 1);
      if (cleaned === undefined) continue;
      out[key] = cleaned;
      kept += 1;
    }
    return out;
  }
  return undefined;
}

/**
 * Strip sensitive keys from audit metadata (passwords, tokens, secrets,
 * TOTP/recovery material, session data) and bound its size. Returns
 * undefined when nothing safe remains.
 */
export function sanitizeAuditMetadata(input: unknown): AuditJsonValue | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const cleaned = sanitizeValue(input, 0);
  if (cleaned === undefined || typeof cleaned !== "object" || Array.isArray(cleaned)) return undefined;
  if (Object.keys(cleaned).length === 0) return undefined;
  return cleaned;
}

/** Minimal store shape for audit writes. Both the base client (`db`) and
 * a transaction client (`tx`) satisfy it, so a record can be written
 * atomically with the business action it describes. Note: metadata is
 * `InputJsonValue | undefined` (never bare null) because Prisma's Json
 * input rejects a literal null — an omitted field stores NULL. */
type AuditLogStore = {
  adminAuditLog: {
    create: (args: {
      data: {
        adminUserId: string | null;
        action: string;
        targetType: string;
        targetId: string | null;
        requestId: string | null;
        ipAddress: string | null;
        userAgent: string | null;
        metadata?: AuditJsonValue;
      };
    }) => Promise<unknown>;
  };
};

/**
 * Record one audit entry. Pass a transaction client as `store` to write it
 * atomically with the business action. The caller must only call this after
 * the business operation has succeeded (or inside the same transaction):
 * a failed action must never produce a success record.
 */
export async function recordAdminAudit(
  context: AdminAuditContext,
  input: {
    action: AdminAuditAction | string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
  store: AuditLogStore = db
): Promise<void> {
  const metadata = input.metadata ? sanitizeAuditMetadata(input.metadata) : undefined;
  await store.adminAuditLog.create({
    data: {
      adminUserId: context.adminUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ? context.userAgent.slice(0, 512) : null,
      ...(metadata !== undefined ? { metadata } : {}),
    },
  });
}

/**
 * Best-effort variant for audit records written AFTER a business operation
 * has already committed (route-layer hooks). A failed audit write must
 * never fail an already-successful business operation, but it must also
 * never be silent: the failure is surfaced through error monitoring so an
 * operator can see the gap. Prefer the transactional `recordAdminAudit`
 * (inside the business transaction) for financial and security-critical
 * actions; use this only where the business operation has no transaction
 * to join.
 */
export async function recordAdminAuditBestEffort(
  context: AdminAuditContext,
  input: {
    action: AdminAuditAction | string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await recordAdminAudit(context, input);
  } catch (error) {
    captureError(error, {
      operation: "admin-audit-log",
      code: "AUDIT_WRITE_FAILED",
      requestId: context.requestId,
    });
  }
}

export type AdminAuditLogEntry = {
  id: string;
  adminUserId: string | null;
  adminEmail: string | null;
  adminName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
};

export type AdminAuditLogFilters = {
  adminUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  perPage?: number;
};

/** Paginated, filterable read for the admin viewer. Read-only: there is
 * deliberately no update or delete path for audit records. */
export async function listAdminAuditLogs(filters: AdminAuditLogFilters = {}): Promise<{
  entries: AdminAuditLogEntry[];
  total: number;
  page: number;
  perPage: number;
}> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(filters.perPage ?? 25)));
  const where: {
    adminUserId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    createdAt?: { gte?: Date; lte?: Date };
  } = {};
  if (filters.adminUserId) where.adminUserId = filters.adminUserId;
  if (filters.action) where.action = filters.action;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.targetId) where.targetId = filters.targetId;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to) where.createdAt.lte = filters.to;
  }
  const [rows, total] = await Promise.all([
    db.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { adminUser: { select: { email: true, name: true } } },
    }),
    db.adminAuditLog.count({ where }),
  ]);
  return {
    entries: rows.map((row) => ({
      id: row.id,
      adminUserId: row.adminUserId,
      adminEmail: row.adminUser?.email ?? null,
      adminName: row.adminUser?.name ?? null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      requestId: row.requestId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      metadata: row.metadata,
      createdAt: row.createdAt,
    })),
    total,
    page,
    perPage,
  };
}
