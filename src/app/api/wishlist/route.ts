// Wishlist toggle (FR-05 — registered customers only).
import { z } from "zod";
import { toggleWishlist } from "@/services/wishlist.service";
import { requireUser } from "@/lib/auth-guard";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";

const schema = z.object({ productId: z.string().min(1) });

export async function POST(request: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const parsed = await parseBody(request, schema);
    if (parsed.error) return parsed.error;
    const result = await toggleWishlist(user.id, parsed.data.productId);
    return jsonOk(result);
  });
}
