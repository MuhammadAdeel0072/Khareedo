// Admin inventory page (FR-40, FR-45).
import { adminListInventory } from "@/services/inventory.service";
import { InventoryManager } from "@/components/admin/inventory-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Inventory · Admin" };

export default async function AdminInventoryPage() {
  const rows = await adminListInventory();
  return (
    <div className="p-4 sm:p-6">
      <InventoryManager initial={rows} />
    </div>
  );
}
