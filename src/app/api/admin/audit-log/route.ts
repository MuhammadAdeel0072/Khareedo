// Admin audit-log viewer (PR-12). Read-only: lists append-only audit
// records for MFA-verified admins, with filters and pagination. There is
// deliberately no update or delete endpoint for audit records.
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { handleRoute, jsonOk } from "@/lib/api";
import { listAdminAuditLogs } from "@/services/admin-audit.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireAdminMfaVerified();
    const url = new URL(request.url);
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const perPage = Number.parseInt(url.searchParams.get("perPage") ?? "25", 10);
    const result = await listAdminAuditLogs({
      adminUserId: url.searchParams.get("adminUserId") ?? undefined,
      action: url.searchParams.get("action") ?? undefined,
      targetType: url.searchParams.get("targetType") ?? undefined,
      targetId: url.searchParams.get("targetId") ?? undefined,
      from: parseDate(url.searchParams.get("from")),
      to: parseDate(url.searchParams.get("to")),
      page: Number.isNaN(page) ? 1 : page,
      perPage: Number.isNaN(perPage) ? 25 : perPage,
    });
    return jsonOk({
      entries: result.entries.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      perPage: result.perPage,
    });
  });
}
