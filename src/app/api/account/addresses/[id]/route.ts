// Address update/delete with ownership check (FR-05, NFR-11).
import { updateAddress, deleteAddress } from "@/services/users.service";
import { requireUser } from "@/lib/auth-guard";
import { jsonError, jsonOk, handleRoute } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await request.json().catch(() => null);
    if (!body) return jsonError("Invalid request body", 400);
    const result = await updateAddress(user.id, id, body);
    if (!result.ok) return jsonError("Please correct the highlighted fields.", 422, { errors: result.errors });
    return jsonOk({ address: result.address });
  });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await deleteAddress(user.id, id);
    if (!result.ok) return jsonError("Address not found.", 404);
    return jsonOk({});
  });
}
