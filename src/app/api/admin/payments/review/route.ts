import { requireAdmin, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const admin = await requireAdmin();

    const limit = rateLimit(
      `payments-review:${admin.id}`,
      30,
      60_000
    );

    if (!limit.ok) {
      return Response.json(
        { ok: false, code: "RATE_LIMITED" },
        { status: 429, headers: noStore }
      );
    }

    const orders = await db.order.findMany({
      where: {
        paymentFlowVersion: 1,
        paymentReviewStatus: "REQUIRED",
      },
      select: {
        id: true,
        reference: true,
        status: true,
        paymentStatus: true,
        paymentReviewReason: true,
        checkoutCloseReason: true,
        checkoutClosedAt: true,
        reservationExpiresAt: true,
      },
      orderBy: [
        { checkoutClosedAt: "asc" },
        { id: "asc" },
      ],
      take: 25,
    });

    return Response.json(
      {
        ok: true,
        cases: orders.map(order => ({
          orderId: order.id,
          reference: order.reference,
          orderStatus: order.status,
          paymentStatus: order.paymentStatus,
          reviewReason: order.paymentReviewReason,
          closeReason: order.checkoutCloseReason,
          closedAt: order.checkoutClosedAt?.toISOString() ?? null,
          reservationExpiresAt:
            order.reservationExpiresAt?.toISOString() ?? null,
        })),
      },
      { headers: noStore }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json(
        {
          ok: false,
          code: error.status === 403
            ? "FORBIDDEN"
            : "UNAUTHENTICATED",
        },
        { status: error.status, headers: noStore }
      );
    }

    throw error;
  }
}
