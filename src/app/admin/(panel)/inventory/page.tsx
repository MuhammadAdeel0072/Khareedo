// Admin inventory page (FR-40, FR-45).
// URL is the single source of truth: q (search), filter and page all live in
// the query string, so refresh / Back / Forward stay consistent.
import { adminListInventory, getInventoryReservationDrift } from "@/services/inventory.service";
import { InventoryManager, type InventoryFilter } from "@/components/admin/inventory-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inventory · Admin" };

const FILTERS: InventoryFilter[] = ["all", "low", "out"];

export default async function AdminInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const rawFilter = typeof params.filter === "string" ? params.filter : "all";
  const filter: InventoryFilter = (FILTERS as readonly string[]).includes(rawFilter)
    ? (rawFilter as InventoryFilter)
    : "all";
  const page = Number(typeof params.page === "string" ? params.page : "1") || 1;
  const [result, drift] = await Promise.all([
    adminListInventory({ q: q || undefined, filter, page }),
    getInventoryReservationDrift(),
  ]);
  return (
    <div className="p-4 sm:p-6">
      <InventoryManager
        key={`${q}|${filter}|${result.page}`}
        initial={result.rows}
        drift={drift}
        q={q}
        filter={filter}
        page={result.page}
        pages={result.pages}
        total={result.total}
      />
    </div>
  );
}
