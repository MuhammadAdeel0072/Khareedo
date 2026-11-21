// Admin: order status update via the permitted state machine (FR-41, BR-11).
import { adminUpdateOrderStatus } from "@/services/orders.service";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/constants";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { jsonError, jsonOk, handleRoute, readBoundedBodyText } from "@/lib/api";
import { adminAuditContext } from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const limit = rateLimit(`admin-orders-status:${admin.id}`, 60, 60_000);
    if (!limit.ok) {
      return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
        headers: { "Retry-After": String(limit.retryAfterSec) },
      });
    }
    const { id } = await ctx.params;
    // Stage 3 audit, L-5: the body is read under parseBody's 1 MiB cap
    // (the old request.json() had no cap). An oversized body is 413; an
    // unparseable body still yields null here, so the manual checks below
    // answer 422 "Invalid order status." exactly as before.
    const read = await readBoundedBodyText(request);
    if (!read.ok && read.reason === "too-large") {
      return jsonError("Request body is too large.", 413);
    }
    let body: unknown = null;
    if (read.ok) {
      try { body = JSON.parse(read.text); } catch { body = null; }
    }
    const status = (body as { status?: string } | null)?.status;
    if (!status || !ORDER_STATUSES.includes(status as OrderStatus)) {
      return jsonError("Invalid order status.", 422);
    }
    // Optional cancellation reason (admin cancel only; forwarded to the
    // order's cancellation record).
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      return jsonError("Invalid cancellation reason.", 422);
    }
    // Optional shipment tracking (D4): plain text, applied only when the
    // status is SHIPPED; ignored for any other transition.
    const cleanTracking = (value: unknown): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") return null;
      const trimmed = value.trim().slice(0, 100);
      return trimmed.length > 0 ? trimmed : null;
    };
    const carrier = (body as { carrier?: unknown } | null)?.carrier;
    const trackingNumber = (body as { trackingNumber?: unknown } | null)?.trackingNumber;
    if (
      (carrier !== undefined && carrier !== null && typeof carrier !== "string") ||
      (trackingNumber !== undefined && trackingNumber !== null && typeof trackingNumber !== "string")
    ) {
      return jsonError("Invalid shipment tracking.", 422);
    }
    const result = await adminUpdateOrderStatus(
      id,
      status as OrderStatus,
      adminAuditContext(request, admin),
      {
        cancelReason: typeof reason === "string" ? reason : null,
        carrier: cleanTracking(carrier),
        trackingNumber: cleanTracking(trackingNumber),
      }
    );
    if (!result.ok) {
      // Stage 3 audit, M-4: a missing order is 404, not 409 — the admin
      // UI must be able to distinguish "no such order" from an illegal
      // transition (which stays 409).
      return jsonError(result.error ?? "Unable to update order status.", result.code === "NOT_FOUND" ? 404 : 409);
    }
    return jsonOk({});
  });
}
