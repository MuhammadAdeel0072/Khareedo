// Admin promotions page (FR-42).
import { db } from "@/lib/db";
import { PromotionsManager } from "@/components/admin/promotions-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Promotions · Admin" };

export default async function AdminPromotionsPage() {
  const promotions = await db.promotion.findMany({ orderBy: { createdAt: "desc" } });
  return (
    <div className="p-4 sm:p-6">
      <PromotionsManager
        initial={promotions.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          type: p.type as "PERCENT" | "FIXED",
          value: p.value,
          minOrderAmount: p.minOrderAmount,
          startsAt: p.startsAt?.toISOString() ?? null,
          endsAt: p.endsAt?.toISOString() ?? null,
          isActive: p.isActive,
        }))}
      />
    </div>
  );
}
