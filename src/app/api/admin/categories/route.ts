// Admin: category create (FR-40).
import { adminCreateCategory } from "@/services/categories.service";
import { categorySchema } from "@/lib/validation";
import { requireAdmin } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const parsed = await parseBody(request, categorySchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const category = await adminCreateCategory({
      name: d.name,
      slug: d.slug || undefined,
      description: d.description || undefined,
      imageUrl: d.imageUrl || undefined,
      parentId: d.parentId || null,
      isActive: d.isActive,
      sortOrder: d.sortOrder,
    });
    return jsonOk({ category });
  });
}
