// Admin coupons page (FR-42, D-06).
import { db } from "@/lib/db";
import { CouponsManager } from "@/components/admin/coupons-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coupons · Admin" };

export default async function AdminCouponsPage() {
  // Bounded read: the manager renders the full list client-side, so the cap
  // is a safety bound (far above any realistic coupon count), not pagination.
  const coupons = await db.coupon.findMany({ orderBy: { createdAt: "desc" }, take: 1000 });
  return (
    <div className="p-4 sm:p-6">
      <CouponsManager
        initial={coupons.map((c) => ({
          id: c.id,
          code: c.code,
          description: c.description,
          type: c.type as "PERCENT" | "FIXED",
          value: c.value,
          minOrderAmount: c.minOrderAmount,
          maxUses: c.maxUses,
          maxDiscountAmount: c.maxDiscountAmount,
          firstOrderOnly: c.firstOrderOnly,
          usedCount: c.usedCount,
          startsAt: c.startsAt?.toISOString() ?? null,
          expiresAt: c.expiresAt?.toISOString() ?? null,
          isActive: c.isActive,
        }))}
      />
    </div>
  );
}
