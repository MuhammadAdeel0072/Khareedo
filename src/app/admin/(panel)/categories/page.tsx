// Admin categories page (FR-40).
import { adminListCategories } from "@/services/categories.service";
import { CategoriesManager } from "@/components/admin/categories-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Categories · Admin" };

export default async function AdminCategoriesPage() {
  const categories = await adminListCategories();
  return (
    <div className="p-4 sm:p-6">
      <CategoriesManager initial={categories} />
    </div>
  );
}
