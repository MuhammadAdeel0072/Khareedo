// Cart API — add / update / remove / fetch (FR-14..18).
// All totals computed server-side from current DB prices (FR-16, BR-04).
import { z } from "zod";
import {
  getCartDetails,
  addToCart,
  removeCartItem,
  applyCartItemUpdate,
} from "@/services/cart.service";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { parseBody, jsonError, jsonOk, handleRoute, isTransientDbError, transientDbErrorResponse } from "@/lib/api";
import { withPerformanceTiming } from "@/lib/performance-timing";

const addSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
  /** Optional variant of the product (Chunk 8 — D12). Validated server-side
   *  against the product; a wrong-product / inactive / out-of-stock variant
   *  is a 409, never a silent no-variant add. */
  variantId: z.string().min(1).optional(),
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

// Cart-write error mapping (Stage 3 audit, H-1/M-1): the old catch-all
// returned every failure as 409 with the raw error text, so a DB outage
// (or the V-1 bare-IS syntax error on Postgres) leaked Prisma internals
// and told a retrying client the request itself was wrong. Only the
// service's own user-facing stock/conflict messages stay 409; a
// transient DB failure is 503 with Retry-After; anything else is a
// generic 500 — the raw message never leaves the server.
const CART_CONFLICT_MESSAGES = [
  "This product is not available",
  "Sorry, this product is out of stock",
  "Cart not found",
  "Cart item not found",
  "This variant is no longer available",
];

function isCartConflictMessage(message: string): boolean {
  if (CART_CONFLICT_MESSAGES.includes(message)) return true;
  return message.startsWith("Only ") && message.endsWith(" unit(s) available in stock");
}

function cartWriteErrorResponse(error: unknown) {
  if (isTransientDbError(error)) return transientDbErrorResponse();
  if (error instanceof Error && isCartConflictMessage(error.message)) {
    return jsonError(error.message, 409);
  }
  return jsonError("Something went wrong. Please try again.", 500);
}

function cartPayload(details: Awaited<ReturnType<typeof getCartDetails>>) {
  return {
    cart: details ?? { items: [], itemCount: 0, subtotal: 0, wrappedUnits: 0, removed: [], id: null },
  };
}

// Cart reads and writes are cheap per request but unbounded in aggregate:
// a flood of cart mutations is a free DB burn, and a guest cart is keyed by
// an unguessable cookie, so a per-IP cap is the only cheap backstop.
// 60/min per client IP across all cart methods (Phase 2, area A). Returns
// a 429 response when the caller is over budget, else null.
function checkCartRateLimit(request: Request) {
  const ip = clientIp(request.headers);
  const limit = rateLimit(`cart:${ip}`, 60, 60 * 1000);
  if (limit.ok) return null;
  return jsonError(`Too many requests. Please try again in ${limit.retryAfterSec}s.`, 429, undefined, {
    headers: { "Retry-After": String(limit.retryAfterSec) },
  });
}

export async function GET(request: Request) {
  return handleRoute(async () => {
    const limited = checkCartRateLimit(request);
    if (limited) return limited;
    const details = await getCartDetails();
    return jsonOk(cartPayload(details));
  });
}

export async function POST(request: Request) {
  return withPerformanceTiming("api.cart.add", () => handleRoute(async () => {
    const limited = checkCartRateLimit(request);
    if (limited) return limited;
    const parsed = await parseBody(request, addSchema);
    if (parsed.error) return parsed.error;
    const { productId, quantity, variantId } = parsed.data;
    try {
      const cart = await addToCart(productId, quantity, variantId);
      return jsonOk({ cart });
    } catch (e) {
      return cartWriteErrorResponse(e);
    }
  }));
}

export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const limited = checkCartRateLimit(request);
    if (limited) return limited;
    const parsed = await parseBody(request, updateSchema);
    if (parsed.error) return parsed.error;
    const { itemId, quantity, giftWrap } = parsed.data;
    try {
      // One pass, one cart-details re-fetch even when both fields are sent.
      const details = await applyCartItemUpdate(itemId, { quantity, giftWrap });
      return jsonOk(cartPayload(details));
    } catch (e) {
      return cartWriteErrorResponse(e);
    }
  });
}

export async function DELETE(request: Request) {
  return handleRoute(async () => {
    const limited = checkCartRateLimit(request);
    if (limited) return limited;
    const parsed = await parseBody(request, removeSchema);
    if (parsed.error) return parsed.error;
    try {
      const details = await removeCartItem(parsed.data.itemId);
      return jsonOk(cartPayload(details));
    } catch (e) {
      return cartWriteErrorResponse(e);
    }
  });
}
