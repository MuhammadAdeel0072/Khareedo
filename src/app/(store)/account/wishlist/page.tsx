// Wishlist page (FR-05).
import { redirect } from "next/navigation";
import { getWishlist } from "@/services/wishlist.service";
import { getSessionUser } from "@/lib/auth-guard";
import { WishlistGrid } from "@/components/account/wishlist-grid";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Wishlist" };

export default async function WishlistPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=/account/wishlist");
  const wishlist = await getWishlist(user.id);

  return (
    <div>
      <h1 className="text-2xl font-extrabold tracking-tight">My Wishlist</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">
        {wishlist.length} saved item{wishlist.length === 1 ? "" : "s"}
      </p>
      <WishlistGrid initial={wishlist} />
    </div>
  );
}
