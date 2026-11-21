// Cart Server Actions — guest-cart merge trigger (Phase 3, H-6/D7).
//
// D7 (C): a signed-in customer's guest cart is merged on the cart page and
// on the post-login landing page (/account — the default callbackUrl), not
// only when they reach /checkout. The merge itself lives in
// src/services/cart.service.ts (mergeGuestCart, validated per H-7); this
// file is only the trigger, so every call site shares the one merge
// function and the merge stays safe to run twice (second run is a no-op:
// the guest cart row is gone, so there is nothing left to merge).
//
// Why a Server Action: Next.js seals cookies() during Server Component
// render, so a merge called from a page cannot delete the guest-cart
// cookie (mergeGuestCart degrades to best-effort there and reports
// cookieCleared: false). Server Actions run with a mutable cookie store,
// so the cookie delete inside mergeGuestCart takes effect when the merge
// is triggered from here. Anonymous visitors get null and their guest
// cart is untouched — the merge never runs without a session.
"use server";

import { getSessionUser } from "@/lib/auth-guard";
import { mergeGuestCart } from "@/services/cart.service";
import type { GuestCartMergeSummary } from "@/types/cart";

/** Merge the current visitor's guest cart into their user cart, if any.
 *  Returns null for anonymous visitors (no merge, guest cart untouched). */
export async function mergeGuestCartAction(): Promise<GuestCartMergeSummary | null> {
  const user = await getSessionUser();
  if (!user?.id) return null;
  return mergeGuestCart(user.id);
}
