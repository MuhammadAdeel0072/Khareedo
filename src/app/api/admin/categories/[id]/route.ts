// Admin: category update / delete (FR-40).
import { adminUpdateCategory, adminDeleteCategory } from "@/services/categories.service";
import { categorySchema } from "@/lib/validation";
import { requireAdminMfaVerified } from "@/lib/auth-guard";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import {
  ADMIN_AUDIT_ACTIONS,
  adminAuditContext,
  recordAdminAuditBestEffort,
} from "@/services/admin-audit.service";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const { id } = await ctx.params;
    const parsed = await parseBody(request, categorySchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const category = await adminUpdateCategory(id, {
      name: d.name,
      slug: d.slug || undefined,
      description: d.description || undefined,
      imageUrl: d.imageUrl || undefined,
      parentId: d.parentId || null,
      isActive: d.isActive,
      sortOrder: d.sortOrder,
    });
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.CATEGORY_UPDATED,
      targetType: "Category",
      targetId: id,
      metadata: { name: d.name },
    });
    return jsonOk({ category });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const admin = await requireAdminMfaVerified();
    const { id } = await ctx.params;
    const result = await adminDeleteCategory(id);
    if (!result.ok) return jsonError(result.reason ?? "Cannot delete this category.", 409);
    await recordAdminAuditBestEffort(adminAuditContext(request, admin), {
      action: ADMIN_AUDIT_ACTIONS.CATEGORY_DELETED,
      targetType: "Category",
      targetId: id,
    });
    return jsonOk({});
  });
}
