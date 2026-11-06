// Server-side checkout quote — the authoritative price preview (BR-06, BR-07, NFR-30).
import { z } from "zod";
import { quoteOrder } from "@/services/checkout.service";
import { getSessionUser } from "@/lib/auth-guard";
import { jsonError, parseBody, jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

const quoteSchema = z.object({
  deliveryMethod: z.enum(["STANDARD", "EXPRESS"]).default("STANDARD"),
  couponCode: z.string().trim().max(40).optional().or(z.literal("")),
});

export async function POST(request: Request) {
  return withPerformanceTiming("api.checkout.quote", () => handleRoute(async () => {
    if (!await getSessionUser()) {
      return jsonError("Please sign in to continue to checkout.", 401, { code: "AUTHENTICATION_REQUIRED" });
    }

    const parsed = await parseBody(request, quoteSchema);
    if (parsed.error) return parsed.error;
    const quote = await quoteOrder(parsed.data);
    return jsonOk({ quote });
  }));
}
