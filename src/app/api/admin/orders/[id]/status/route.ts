// Admin: order status update via the permitted state machine (FR-41, BR-11).
import { adminUpdateOrderStatus } from "@/services/orders.service";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/constants";
import { requireAdmin } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await ctx.params;
    const body = await request.json().catch(() => null);
    const status = (body as { status?: string } | null)?.status;
    if (!status || !ORDER_STATUSES.includes(status as OrderStatus)) {
      return jsonError("Invalid order status.", 422);
    }
    const result = await adminUpdateOrderStatus(id, status as OrderStatus);
    if (!result.ok) return jsonError(result.error ?? "Unable to update order status.", 409);
    return jsonOk({});
  });
}
