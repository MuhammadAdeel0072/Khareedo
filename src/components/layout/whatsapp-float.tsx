"use client";

// Floating WhatsApp button + product/cart inquiry messages (FR-33..37, BR-13).
import { WhatsAppIcon } from "@/components/layout/whatsapp-icon";
import { buildCartInquiryMessage } from "@/lib/whatsapp-messages";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function WhatsAppFloat({
  number,
  storeName,
}: {
  number: string;
  storeName: string;
}) {
  const href = `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(
    `Hello ${storeName}! I need some assistance with my shopping.`
  )}`;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Chat with us on WhatsApp (inquiry only — not an order)"
            className="fixed bottom-[calc(6.5rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 lg:bottom-5 lg:right-5"
          >
            <WhatsAppIcon className="h-7 w-7" />
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-60" />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-white bg-[#25D366]" />
            </span>
          </a>
        </TooltipTrigger>
        <TooltipContent side="left">Chat with us on WhatsApp</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Cart-page WhatsApp assistance button — prepares a message with cart contents. */
export function WhatsAppCartButton({
  number,
  storeName,
  items,
  subtotal,
  className,
}: {
  number: string;
  storeName: string;
  items: Array<{ name: string; quantity: number }>;
  subtotal: number;
  className?: string;
}) {
  const message = buildCartInquiryMessage(storeName, items, subtotal);
  return (
    <a
      href={`https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      <WhatsAppIcon className="h-4 w-4" />
      Order assistance on WhatsApp
    </a>
  );
}
