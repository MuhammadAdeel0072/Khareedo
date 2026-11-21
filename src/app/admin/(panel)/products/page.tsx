// Admin products list (FR-39) — table rendered client-side with inline Add/Edit dialog.
import { adminListProducts } from "@/services/products.service";
import { ProductsManager } from "@/components/admin/products-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Products · Admin" };

export default async function AdminProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : undefined;
  const status = typeof params.status === "string" && params.status ? params.status : undefined;
  const categoryId =
    typeof params.categoryId === "string" && params.categoryId ? params.categoryId : undefined;
  const page = Number(typeof params.page === "string" ? params.page : "1") || 1;

  const result = await adminListProducts({ q, status, categoryId, page });

  return (
    <div className="p-4 sm:p-6">
      <ProductsManager
        items={result.items}
        total={result.total}
        pages={result.pages}
        page={result.page}
        q={q}
        status={status}
        categoryId={categoryId}
        categories={result.categories}
      />
    </div>
  );
}
