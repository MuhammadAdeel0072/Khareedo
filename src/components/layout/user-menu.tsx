"use client";

// User menu — account links or sign-in prompt + secure sign-out (FR-04).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { LayoutDashboard, LogOut, Package, User, Heart, MapPin } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";

export function UserMenu({
  name,
  email,
  role,
}: {
  name?: string | null;
  email?: string | null;
  role?: string | null;
}) {
  const router = useRouter();

  if (!email) {
    return (
      <Link
        href="/login"
        className="flex h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-muted-foreground transition-colors hover:text-primary"
      >
        <User className="h-5 w-5" aria-hidden="true" />
        <span className="text-[11px] font-medium max-[399px]:sr-only">Account</span>
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-md px-2 text-muted-foreground outline-none transition-colors hover:text-primary"
      >
        <Avatar className="h-5 w-5">
          <AvatarFallback className="bg-primary text-[10px] text-primary-foreground">
            {initials(name ?? email)}
          </AvatarFallback>
        </Avatar>
        <span className="max-w-16 truncate text-[11px] font-medium max-[399px]:sr-only">{name?.split(" ")[0] ?? "Account"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="truncate">
          <span className="block truncate font-semibold">{name ?? "My Account"}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {role === "ADMIN" && (
          <DropdownMenuItem onClick={() => router.push("/admin")}>
            <LayoutDashboard className="h-4 w-4" /> Admin Dashboard
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => router.push("/account")}>
          <User className="h-4 w-4" /> My Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/account/orders")}>
          <Package className="h-4 w-4" /> My Orders
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/account/wishlist")}>
          <Heart className="h-4 w-4" /> Wishlist
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/account/addresses")}>
          <MapPin className="h-4 w-4" /> Addresses
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            await signOut({ redirect: false });
            router.push("/");
            router.refresh();
          }}
        >
          <LogOut className="h-4 w-4" /> Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
