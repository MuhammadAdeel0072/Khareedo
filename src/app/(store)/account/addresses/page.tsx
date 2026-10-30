// Addresses page (FR-05).
import { redirect } from "next/navigation";
import { listAddresses } from "@/services/users.service";
import { getSessionUser } from "@/lib/auth-guard";
import { AddressesManager } from "@/components/account/addresses-manager";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Addresses" };

export default async function AddressesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=/account/addresses");
  const addresses = await listAddresses(user.id);

  return (
    <AddressesManager
      initial={addresses.map((a) => ({
        id: a.id,
        label: a.label,
        fullName: a.fullName,
        phone: a.phone,
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        province: a.province,
        postalCode: a.postalCode,
        isDefault: a.isDefault,
      }))}
    />
  );
}
