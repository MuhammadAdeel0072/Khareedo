// Cart API — add / update / remove / fetch (FR-14..18).
// All totals computed server-side from current DB prices (FR-16, BR-04).
import { z } from "zod";
import {
  getCartDetails,
  addToCart,
  removeCartItem,
  applyCartItemUpdate,
} from "@/services/cart.service";
import { parseBody, jsonError, jsonOk, handleRoute } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

const addSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
});

const updateSchema = z
  .object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().int().min(0).max(20).optional(),
    giftWrap: z.boolean().optional(),
  })
  .refine((v) => v.quantity !== undefined || v.giftWrap !== undefined, {
    message: "Nothing to update",
  });

const removeSchema = z.object({ itemId: z.string().min(1) });

function cartPayload(details: Awaited<ReturnType<typeof getCartDetails>>) {
  return {
    cart: details ?? { items: [], itemCount: 0, subtotal: 0, wrappedUnits: 0, id: null },
  };
}

export async function GET() {
  return handleRoute(async () => {
    const details = await getCartDetails();
    return jsonOk(cartPayload(details));
  });
}

export async function POST(request: Request) {
  return withPerformanceTiming("api.cart.add", () => handleRoute(async () => {
    const parsed = await parseBody(request, addSchema);
    if (parsed.error) return parsed.error;
    const { productId, quantity } = parsed.data;
    try {
      const cart = await addToCart(productId, quantity);
      return jsonOk({ cart });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : "Could not add to cart", 409);
    }
  }));
}

export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const parsed = await parseBody(request, updateSchema);
    if (parsed.error) return parsed.error;
    const { itemId, quantity, giftWrap } = parsed.data;
    try {
      // One pass, one cart-details re-fetch even when both fields are sent.
      const details = await applyCartItemUpdate(itemId, { quantity, giftWrap });
      return jsonOk(cartPayload(details));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : "Could not update cart", 409);
    }
  });
}

export async function DELETE(request: Request) {
  return handleRoute(async () => {
    const parsed = await parseBody(request, removeSchema);
    if (parsed.error) return parsed.error;
    try {
      const details = await removeCartItem(parsed.data.itemId);
      return jsonOk(cartPayload(details));
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : "Could not remove item", 409);
    }
  });
}
