// Storefront layout — shared chrome for all customer pages.
import { StoreHeader } from "@/components/layout/store-header";
import { StoreFooter } from "@/components/layout/store-footer";
import { WhatsAppFloat } from "@/components/layout/whatsapp-float";
import { MobileNav } from "@/components/layout/mobile-nav";
import { getSettings } from "@/services/settings.service";

export const dynamic = "force-dynamic";

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const settings = await getSettings();

  return (
    <div className="flex min-h-screen flex-col">
      <StoreHeader settings={settings} />
      <main className="flex-1">{children}</main>
      <StoreFooter settings={settings} />
      <WhatsAppFloat number={settings.whatsapp_number} storeName={settings.store_name} />
      <MobileNav />
    </div>
  );
}
