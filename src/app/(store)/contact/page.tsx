// Contact page — store contact info + WhatsApp CTA (FR-33/34, BR-13).
import type { Metadata } from "next";
import { Mail, MapPin, Phone } from "lucide-react";
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import { getSettings } from "@/services/settings.service";
import { buildInquiryMessage } from "@/lib/whatsapp-messages";

export const metadata: Metadata = { title: "Contact Us" };
export const dynamic = "force-dynamic";

export default async function ContactPage() {
  const settings = await getSettings();
  const waHref = `https://wa.me/${settings.whatsapp_number.replace(/\D/g, "")}?text=${encodeURIComponent(buildInquiryMessage(settings.store_name))}`;

  return (
    <div className="container-khd max-w-2xl py-12">
      <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Contact Us</h1>
      <p className="mb-8 mt-1 text-sm text-muted-foreground">
        We&apos;re here to help with orders, products and anything else
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <a
          href={waHref}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 rounded-xl border p-5 transition hover:border-[#25D366]/50 hover:bg-[#25D366]/5 sm:col-span-2"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#25D366] text-white">
            <WhatsAppIcon className="h-6 w-6" />
          </span>
          <div>
            <p className="font-bold">WhatsApp Assistance</p>
            <p className="text-sm text-muted-foreground">
              Fastest response — ask about products, orders and delivery
            </p>
          </div>
        </a>

        <div className="rounded-xl border p-5">
          <Phone className="h-5 w-5 text-primary" aria-hidden="true" />
          <p className="mt-2 font-bold">Phone</p>
          <p className="mt-1 text-sm text-muted-foreground">{settings.store_phone}</p>
        </div>
        <div className="rounded-xl border p-5">
          <Mail className="h-5 w-5 text-primary" aria-hidden="true" />
          <p className="mt-2 font-bold">Email</p>
          <a href={`mailto:${settings.store_email}`} className="mt-1 block text-sm text-muted-foreground hover:text-primary">
            {settings.store_email}
          </a>
        </div>
        <div className="rounded-xl border p-5 sm:col-span-2">
          <MapPin className="h-5 w-5 text-primary" aria-hidden="true" />
          <p className="mt-2 font-bold">Store Address</p>
          <p className="mt-1 text-sm text-muted-foreground">{settings.store_address}</p>
        </div>
      </div>

      <p className="mt-6 rounded-lg bg-brand-50 p-4 text-xs leading-5 text-muted-foreground">
        WhatsApp and email are for <span className="font-semibold text-foreground">inquiries only</span> —
        orders are confirmed through website checkout.
      </p>
    </div>
  );
}
