# Admin Audit Log (PR-12)

Append-only record of security-relevant administrator actions. One row per
action, written by the application and never updated or deleted through any
API or page.

## What is recorded

| Action | When |
|---|---|
| `admin.auth.login` | An administrator signs in (credentials, email-verification, or Google). Recorded by the NextAuth `signIn` event. No IP/user-agent is available there — only the admin id, action, and target. |
| `admin.mfa.enrollment_started` | An admin starts (or restarts) first-time MFA enrollment. |
| `admin.mfa.activated` | First-time MFA activation succeeds (inside the activation transaction). |
| `admin.mfa.replacement_started` | An admin starts an authenticator replacement (password + current code verified first). |
| `admin.mfa.replacement_activated` | A replacement activation succeeds (inside the swap transaction). |
| `admin.mfa.disabled` | MFA is disabled (password + code verified first). |
| `admin.mfa.recovery_codes_regenerated` | Recovery codes are regenerated (inside the rotation transaction). |
| `admin.product.created` / `.updated` / `.archived` | Product mutations. |
| `admin.category.created` / `.updated` / `.deleted` | Category mutations. |
| `admin.inventory.updated` | Inventory quantity change. |
| `admin.order.status_changed` | Order status change (inside the status transaction, with `from`/`to` in metadata). |
| `admin.payment.refund_requested` | A refund is requested. |
| `admin.payment.maintenance_run` | A payment-maintenance action runs. |
| `admin.settings.updated` | Store settings are saved (metadata lists the setting keys that were saved — the save is a full-object write — never values). |
| `admin.banner.created` / `.updated` / `.deleted` | Banner mutations. |
| `admin.coupon.created` / `.updated` / `.deleted` | Coupon mutations. |
| `admin.promotion.created` / `.updated` / `.deleted` | Promotion mutations. |
| `admin.export.created` | An admin export is generated (PII leaving the system). |
| `admin.upload.created` | An admin uploads an image. |
| `admin.import.completed` | A product import completes. |

## Record fields

- `id` — unique (cuid).
- `adminUserId` — the admin who performed the action. Nullable with
  `ON DELETE SET NULL`, so deleting an admin account does not erase history.
- `action` — stable namespaced string (see table above).
- `targetType` — resource type (`Order`, `Product`, `AdminMfa`, …).
- `targetId` — resource id, null when the action has no single target.
- `requestId` — request correlation id (from the performance context).
- `ipAddress` — client IP from `clientIp()` (first `X-Forwarded-For`
  entry). Carries the same trusted-proxy caveat as every per-IP limit in
  the app: it is reliable only behind a proxy that overwrites the header.
- `userAgent` — truncated to 512 characters.
- `metadata` — minimal structured context (e.g. order `from`/`to`
  statuses, changed setting keys). See "What is never stored".
- `createdAt` — timestamp.

## What is never stored

Metadata is passed through `sanitizeAuditMetadata` before every write. It
drops any key matching (case-insensitive) `password`, `secret`, `token`,
`cookie`, `authorization`, `totp`, `recovery`, `credential`,
`private_key`, `api_key`, or `session`, at any nesting depth. It also
bounds size: strings truncated to 500 characters, depth to 3, 50 keys per
object, 20 items per array. So passwords, session cookies, auth tokens,
TOTP secrets, recovery codes, payment secrets, and raw request bodies can
never reach the audit table through this service.

## Append-only

- The service (`src/services/admin-audit.service.ts`) exposes only
  `recordAdminAudit` / `recordAdminAuditBestEffort` (write) and
  `listAdminAuditLogs` (read). There is no update or delete function.
- There is no update or delete API endpoint for audit records.
- The admin viewer (`/admin/audit-log`) is read-only.

## Atomicity model

Two write paths, chosen per hook:

- **Transactional** (`recordAdminAudit(..., tx)`): used where the business
  action already runs in a transaction — MFA activation, MFA recovery-code
  regeneration, and order status changes. The audit row is written inside
  the same transaction, so the business action and its record succeed or
  fail together. A failed action never produces a success record, and a
  failed audit write rolls the business action back.
- **Best-effort after success** (`recordAdminAuditBestEffort`): used for
  mutations with no transaction to join (products, categories, inventory,
  settings, banners, coupons, promotions, refunds, maintenance, export,
  upload, import, MFA enrollment/replacement-start/disablement, admin
  login). The record is written only after the business operation has
  succeeded. A failed audit write must never fail an already-successful
  business operation, but it is never silent either: the failure is
  surfaced through error monitoring (`captureError`, operation
  `admin-audit-log`, code `AUDIT_WRITE_FAILED`) so an operator can see the
  gap.

## Viewer

- Page: `/admin/audit-log` (inside the MFA-enforced admin panel; sidebar
  link "Audit log"). Filter by action and resource type, paginated
  (25 per page). Read-only.
- API: `GET /api/admin/audit-log` (MFA-verified admin only). Query params:
  `adminUserId`, `action`, `targetType`, `targetId`, `from`, `to`, `page`,
  `perPage` (max 100). Returns `{ entries, total, page, perPage }`.

## Indexes

- `(adminUserId, createdAt)` — "what did this admin do?"
- `(action, createdAt)` — "when did this kind of action happen?"
- `(targetType, targetId, createdAt)` — "what happened to this resource?"

## Retention and operations

- No automatic retention or deletion is implemented. Audit rows accumulate
  indefinitely until an operator decides a policy. Recommended: keep at
  least 12 months for security review; any future purge must be an
  explicit, deliberate, out-of-band database operation (never through the
  app), and the purge itself should be recorded in the operator's own log.
- The table is server-only: the migration revokes all privileges from
  PUBLIC/anon/authenticated and enables row-level security, matching the
  other sensitive tables.
- `AdminAuditLog` is in both Prisma schemas (`schema.postgres.prisma`,
  `schema.sqlite.prisma`) and migration
  `prisma/migrations/20261119000003_admin_audit_log/migration.sql`.

## Limitations (honest)

- Route-layer (best-effort) records are not in the same transaction as
  their business action. If the audit write fails after a successful
  mutation, the record is lost but the failure is surfaced via error
  monitoring — it is never silent.
- Admin login records have no IP/user-agent (the NextAuth `signIn` event
  has no request context). Failed logins are not recorded (there is no
  clean NextAuth hook for them).
- No in-app role mutation exists today (roles change only via seed/DB), so
  role changes are not audited. If an in-app role change is added later,
  it must call `recordAdminAudit`.
- The audit log does not cover customer actions — only administrator
  actions.
