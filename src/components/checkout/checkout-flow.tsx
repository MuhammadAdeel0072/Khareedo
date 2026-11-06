"use client";

// Checkout flow — 4 steps: Address → Delivery → Payment → Review (FR-19/20).
// All amounts displayed come from the SERVER quote endpoint (BR-04/06/07).
// Order placement uses a per-attempt idempotency key (FR-27/BR-08).
import Image from "next/image";
import Link from "next/link";
import { useCallback, cloneElement, isValidElement, useId, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Check,
  CreditCard,
  Gift,
  Landmark,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  Tag,
  Truck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { cn, formatPKR } from "@/lib/utils";
import type { CartDetails } from "@/types/cart";

// ─── Types ───
interface Quote {
  subtotal: number;
  discountTotal: number;
  deliveryFee: number;
  giftWrapCharge: number;
  wrappedUnits: number;
  taxTotal: number;
  total: number;
  couponError?: string;
  couponApplied?: string;
  itemCount: number;
}

export interface CheckoutAddress {
  id?: string;
  label: string;
  fullName: string;
  email?: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  province: string;
  postalCode?: string | null;
  isDefault?: boolean;
}

export interface CheckoutConfig {
  codEnabled: boolean;
  bankTransferEnabled: boolean;
  sandboxPaymentEnabled: boolean;
  giftWrapEnabled: boolean;
  giftWrapCharge: number;
  giftWrapDescription: string;
  freeDeliveryThreshold: number;
  deliveryFeeStandard: number;
  deliveryFeeExpress: number;
  whatsappNumber: string;
  storeName: string;
}

const STEPS = ["Cart", "Address", "Payment", "Review"] as const;

const EMPTY_FORM: CheckoutAddress = {
  label: "Home",
  fullName: "",
  email: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  province: "Punjab",
  postalCode: "",
};

const PROVINCES = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Gilgit-Baltistan",
  "Azad Kashmir",
  "Islamabad Capital Territory",
];

export function CheckoutFlow({
  cart,
  user,
  savedAddresses,
  config,
  initialName,
  initialEmail,
}: {
  cart: CartDetails;
  user: { id: string; name?: string | null; email?: string | null } | null;
  savedAddresses: CheckoutAddress[];
  config: CheckoutConfig;
  initialName: string;
  initialEmail: string;
}) {
  const router = useRouter();

  // Local cart mirror — per-item gift wrap toggles PATCH the server cart, then
  // the returned authoritative cart (with wrappedUnits) re-drives the quote.
  const [cartState, setCartState] = useState<CartDetails>(cart);

  // Idempotency key: one per visit to checkout; a new attempt after a hard
  // failure gets a fresh key (placed successfully = key consumed server-side).
  const [idempotencyKey] = useState(
    () => `chk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 10)}`
  );

  const [step, setStep] = useState(1);
  const [placing, setPlacing] = useState(false);

  // Address step
  const [addresses, setAddresses] = useState<CheckoutAddress[]>(savedAddresses);
  const selectedDefault =
    addresses.find((a) => a.isDefault) ?? addresses[0] ?? null;
  const [selectedAddressId, setSelectedAddressId] = useState<string>(
    selectedDefault?.id ?? "new"
  );
  const [showNewForm, setShowNewForm] = useState(addresses.length === 0);
  const [form, setForm] = useState<CheckoutAddress>(
    addresses.length === 0
      ? { ...EMPTY_FORM, fullName: initialName, email: initialEmail }
      : { ...EMPTY_FORM, email: initialEmail }
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Delivery / payment
  const [deliveryMethod, setDeliveryMethod] = useState<"STANDARD" | "EXPRESS">("STANDARD");
  const [paymentMethod, setPaymentMethod] = useState<"COD" | "BANK_TRANSFER" | "ONLINE">(
    config.codEnabled ? "COD" : "BANK_TRANSFER"
  );

  // Extras — gift wrap is PER ITEM (toggled on each cart line below); only the
  // shared gift-card note is order-level state here.
  const [giftMessage, setGiftMessage] = useState("");
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [completedQuoteRequest, setCompletedQuoteRequest] = useState<string | null>(null);

  const purchasable = useMemo(() => cartState.items.filter((i) => !i.outOfStock), [cartState.items]);
  const hasStockProblem = purchasable.length < cartState.items.length || cartState.items.some((i) => i.quantity > i.stock);
  const wrappedUnits = useMemo(
    () => purchasable.reduce((s, i) => (i.giftWrap ? s + i.quantity : s), 0),
    [purchasable]
  );

  // ─── Per-item gift wrap toggle (single source of truth: DB cart item flag) ───
  const toggleGiftWrap = useCallback(async (itemId: string, wrap: boolean) => {
    setCartState((prev) => ({
      ...prev,
      items: prev.items.map((i) => (i.itemId === itemId ? { ...i, giftWrap: wrap } : i)),
    }));
    try {
      const res = await fetch("/api/cart", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, giftWrap: wrap }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not update gift wrap");
      setCartState(data.cart as CartDetails);
    } catch {
      toast.error("Could not update gift wrapping. Please try again.");
      setCartState((prev) => ({
        ...prev,
        items: prev.items.map((i) => (i.itemId === itemId ? { ...i, giftWrap: !wrap } : i)),
      }));
    }
  }, []);

  // ─── Server quote (BR-06/07) — wrap flags already live on the server cart ───
  const quoteRequestKey = JSON.stringify([deliveryMethod, couponCode, wrappedUnits]);
  const quoting = completedQuoteRequest !== quoteRequestKey;

  // Re-quote on mount, delivery/coupon change, and whenever the wrapped-unit
  // count changes (per-item gift wrap toggle).
  useEffect(() => {
    let active = true;

    async function refreshQuote() {
      try {
        const res = await fetch("/api/checkout/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deliveryMethod,
            couponCode,
          }),
        });
        const data = await res.json();
        if (active && data.ok) setQuote(data.quote as Quote);
      } catch {
        if (active) toast.error("Could not update the order summary. Please retry.");
      } finally {
        if (active) setCompletedQuoteRequest(quoteRequestKey);
      }
    }

    void refreshQuote();
    return () => {
      active = false;
    };
  }, [deliveryMethod, couponCode, quoteRequestKey]);

  // ─── Address form validation (client-side pre-check; server re-validates) ───
  function validateAddress(a: CheckoutAddress): boolean {
    const errors: Record<string, string> = {};
    if (a.fullName.trim().length < 2) errors.fullName = "Recipient name is required";
    // Guests must supply a contact email for the order record (FR-19, BR-02)
    if (!user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email ?? ""))
      errors.email = "Please enter a valid email address";
    if (!/^(\+?92|0)?\d{10}$/.test(a.phone.replace(/[\s-]/g, "")))
      errors.phone = "Enter a valid phone (e.g. 0300 1234567)";
    if (a.line1.trim().length < 5) errors.line1 = "Please enter the full street address";
    if (a.city.trim().length < 2) errors.city = "City is required";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function saveNewAddress(): Promise<CheckoutAddress | null> {
    if (!validateAddress(form)) return null;
    const res = await fetch("/api/account/addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, isDefault: addresses.length === 0 }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setFieldErrors(data.errors ?? {});
      toast.error("Please correct the highlighted fields.");
      return null;
    }
    const saved = data.address as CheckoutAddress;
    setAddresses((prev) => [saved, ...prev]);
    setSelectedAddressId(saved.id!);
    setShowNewForm(false);
    return saved;
  }

  function activeAddress(): CheckoutAddress | null {
    if (selectedAddressId !== "new") {
      return addresses.find((a) => a.id === selectedAddressId) ?? null;
    }
    return form;
  }

  async function toStep(n: number) {
    if (n === 2 && !validateAddress(form)) return;
    setStep(n);
  }

  // ─── Place order (FR-21..27) ───
  async function placeOrder() {
    const address = activeAddress();
    if (!address || !validateAddress(address)) {
      setStep(1);
      toast.error("Please complete your delivery details first.");
      return;
    }
    setPlacing(true);
    try {
      // Signed-in + new address → persist it first (FR-05)
      if (user && selectedAddressId === "new") {
        await saveNewAddress();
      }

      const onlinePayment = paymentMethod === "ONLINE";
      const res = await fetch(onlinePayment ? "/api/checkout/safepay/session" : "/api/checkout/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          customer: {
            name: user?.name || address.fullName,
            email: user?.email || activeAddress()?.email || "",
            phone: address.phone,
          },
          address: {
            fullName: address.fullName,
            phone: address.phone,
            line1: address.line1,
            line2: address.line2 ?? "",
            city: address.city,
            province: address.province,
            postalCode: address.postalCode ?? "",
          },
          deliveryMethod,
          paymentMethod,
          giftWrapMessage: giftMessage,
          couponCode,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (data.code === "OUT_OF_STOCK") {
          toast.error(data.error);
          router.push("/cart");
          return;
        }
        toast.error(data.error ?? "Could not place your order. Please try again.");
        return;
      }
      window.dispatchEvent(new CustomEvent("cart:updated", { detail: { itemCount: 0 } }));
      if (onlinePayment) {
        let redirect: URL;
        try {
          redirect = new URL(data.redirectUrl);
        } catch {
          toast.error("Could not start secure checkout. Please try again.");
          return;
        }
        if (redirect.origin !== "https://sandbox.api.getsafepay.com" || redirect.pathname !== "/embedded/") {
          toast.error("Could not start secure checkout. Please try again.");
          return;
        }
        window.location.assign(redirect.href);
        return;
      }
      router.push(`/order/${data.reference}`);
    } catch {
      toast.error("Network problem — your order was not placed. Please try again.");
    } finally {
      setPlacing(false);
    }
  }

  // ─── Guards ───
  if (purchasable.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed py-20 text-center">
        <h2 className="text-lg font-bold">Nothing to checkout</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your cart is empty or all items are out of stock.
        </p>
        <Button asChild className="mt-4">
          <Link href="/products">Browse Products</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
      <div>
        {/* Stepper */}
        <ol className="mb-6 flex items-center justify-center gap-0 sm:gap-2" aria-label="Checkout progress">
          {STEPS.slice(1).map((label, i) => {
            const n = i + 1;
            const state = step === n ? "current" : step > n ? "done" : "todo";
            return (
              <li key={label} className="flex items-center">
                <span className="flex flex-col items-center">
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-bold transition",
                      state === "done" && "border-primary bg-primary text-primary-foreground",
                      state === "current" && "border-primary text-primary",
                      state === "todo" && "border-muted-foreground/30 text-muted-foreground"
                    )}
                    aria-current={state === "current" ? "step" : undefined}
                  >
                    {state === "done" ? <Check className="h-4 w-4" /> : n}
                  </span>
                  <span
                    className={cn(
                      "mt-1 hidden text-xs font-medium sm:block",
                      state === "todo" ? "text-muted-foreground" : "text-foreground"
                    )}
                  >
                    {label}
                  </span>
                </span>
                {n < 3 && <span className={cn("mx-1 h-0.5 w-8 sm:w-14", step > n ? "bg-primary" : "bg-muted")} aria-hidden="true" />}
              </li>
            );
          })}
        </ol>

        {/* STEP 1 — Address */}
        {step === 1 && (
          <SectionCard icon={<MapPin className="h-5 w-5" />} title="Shipping Address" subtitle="Choose your delivery address">
            {user && addresses.length > 0 && (
              <RadioGroup
                value={selectedAddressId}
                onValueChange={(v) => {
                  setSelectedAddressId(v);
                  setShowNewForm(v === "new");
                }}
                className="grid gap-3 sm:grid-cols-2"
              >
                {addresses.map((a) => (
                  <Label
                    key={a.id}
                    className={cn(
                      "flex cursor-pointer flex-col gap-1 rounded-xl border p-4 transition",
                      selectedAddressId === a.id && !showNewForm
                        ? "border-primary bg-brand-50 ring-1 ring-primary"
                        : "hover:border-muted-foreground/40"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <RadioGroupItem value={a.id!} />
                      <span className="text-sm font-bold">{a.label}</span>
                      {a.isDefault && (
                        <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                          Default
                        </span>
                      )}
                    </span>
                    <span className="pl-6 text-xs leading-5 text-muted-foreground">
                      {a.fullName} · {a.phone}
                      <br />
                      {a.line1}
                      {a.line2 ? `, ${a.line2}` : ""}
                      <br />
                      {a.city}, {a.province} {a.postalCode ?? ""}
                    </span>
                  </Label>
                ))}
                <Label
                  className={cn(
                    "flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm font-medium transition hover:border-primary/50",
                    showNewForm && "border-primary bg-brand-50 text-primary ring-1 ring-primary"
                  )}
                >
                  <RadioGroupItem value="new" className="sr-only" />
                  <Plus className="h-4 w-4" /> Add New Address
                </Label>
              </RadioGroup>
            )}

            {(showNewForm || !user) && (
              <div className={cn("grid gap-3 sm:grid-cols-2", user && addresses.length > 0 && "mt-4 border-t pt-4")}>
                <Field label="Full Name" error={fieldErrors.fullName}>
                  <Input
                    value={form.fullName}
                    onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                    placeholder="e.g. Ali Hassan"
                    autoComplete="name"
                  />
                </Field>
                <Field label="Phone Number" error={fieldErrors.phone}>
                  <Input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="0300 1234567"
                    inputMode="tel"
                    autoComplete="tel"
                  />
                </Field>
                {!user && (
                  <Field label="Email Address" error={fieldErrors.email} className="sm:col-span-2">
                    <Input
                      type="email"
                      value={form.email ?? ""}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder="you@example.com — for your order confirmation"
                      autoComplete="email"
                    />
                  </Field>
 )}
                <Field label="Street Address" error={fieldErrors.line1} className="sm:col-span-2">
                  <Input
                    value={form.line1}
                    onChange={(e) => setForm({ ...form, line1: e.target.value })}
                    placeholder="House no, street, area"
                    autoComplete="address-line1"
                  />
                </Field>
                <Field label="Apartment, floor (optional)" error={fieldErrors.line2} className="sm:col-span-2">
                  <Input
                    value={form.line2 ?? ""}
                    onChange={(e) => setForm({ ...form, line2: e.target.value })}
                    placeholder="Optional"
                    autoComplete="address-line2"
                  />
                </Field>
                <Field label="City" error={fieldErrors.city}>
                  <Input
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    placeholder="e.g. Lahore"
                    autoComplete="address-level2"
                  />
                </Field>
                <Field label="Province" error={fieldErrors.province}>
                  <select
                    value={form.province}
                    onChange={(e) => setForm({ ...form, province: e.target.value })}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Province"
                  >
                    {PROVINCES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Postal Code (optional)" error={fieldErrors.postalCode}>
                  <Input
                    value={form.postalCode ?? ""}
                    onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                    placeholder="54000"
                    inputMode="numeric"
                    autoComplete="postal-code"
                  />
                </Field>
                {user && (
                  <Field label="Save as" error={fieldErrors.label}>
                    <Input
                      value={form.label}
                      onChange={(e) => setForm({ ...form, label: e.target.value })}
                      placeholder="Home / Office"
                    />
                  </Field>
                )}
              </div>
            )}

            <div className="mt-5 flex justify-end">
              <Button
                size="lg"
                className="w-full sm:w-auto"
                onClick={async () => {
                  if (user && selectedAddressId === "new" && showNewForm) {
                    const saved = await saveNewAddress();
                    if (!saved) return;
                  } else if (!user && !validateAddress(form)) {
                    return;
                  }
                  setStep(2);
                }}
              >
                Continue to Delivery
              </Button>
            </div>
          </SectionCard>
        )}

        {/* STEP 2 — Delivery + Gift wrap */}
        {step === 2 && (
          <>
            <SectionCard icon={<Truck className="h-5 w-5" />} title="Delivery Method" subtitle="Choose how you want to receive your order">
              <RadioGroup value={deliveryMethod} onValueChange={(v) => setDeliveryMethod(v as "STANDARD" | "EXPRESS")} className="grid gap-3">
                <DeliveryOption
                  selected={deliveryMethod === "STANDARD"}
                  onSelect={() => setDeliveryMethod("STANDARD")}
                  title="Standard Delivery"
                  desc="3 - 5 working days"
                  fee={quote?.subtotal !== undefined && config.freeDeliveryThreshold > 0 && quote.subtotal >= config.freeDeliveryThreshold ? 0 : config.deliveryFeeStandard}
                />
                <DeliveryOption
                  selected={deliveryMethod === "EXPRESS"}
                  onSelect={() => setDeliveryMethod("EXPRESS")}
                  title="Express Delivery"
                  desc="1 - 2 working days"
                  fee={config.deliveryFeeExpress}
                />
              </RadioGroup>
            </SectionCard>

            {config.giftWrapEnabled && (
              <SectionCard icon={<Gift className="h-5 w-5" />} title="Gift Wrapping" subtitle={`${config.giftWrapDescription} — ${formatPKR(config.giftWrapCharge)} per item`}>
                {/* Per-item selection: the system wraps exactly the products you tick */}
                <ul className="grid gap-2">
                  {purchasable.map((item) => (
                    <li key={item.itemId}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition",
                          item.giftWrap ? "border-primary bg-brand-50" : "hover:border-muted-foreground/40"
                        )}
                      >
                        <Checkbox
                          checked={item.giftWrap}
                          onCheckedChange={(c) => toggleGiftWrap(item.itemId, c === true)}
                          aria-label={`Gift wrap ${item.name}`}
                        />
                        <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-muted">
                          <Image src={item.image ?? "/images/placeholder.svg"} alt="" fill sizes="40px" className="object-cover" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{item.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            Qty {item.quantity} · {formatPKR(config.giftWrapCharge * item.quantity)}
                          </span>
                        </span>
                        {item.giftWrap && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                      </label>
                    </li>
                  ))}
                </ul>
                {wrappedUnits > 0 && (
                  <div className="mt-3">
                    <Label htmlFor="gift-message" className="text-xs text-muted-foreground">
                      Personal note on the gift card (optional)
                    </Label>
                    <Textarea
                      id="gift-message"
                      value={giftMessage}
                      onChange={(e) => setGiftMessage(e.target.value.slice(0, 200))}
                      placeholder="Happy Birthday!"
                      className="mt-1.5"
                      maxLength={200}
                    />
                  </div>
                )}
              </SectionCard>
            )}

            <div className="mt-5 flex justify-between gap-3">
              <Button variant="ghost" className="flex-1 sm:flex-none" onClick={() => setStep(1)}>← Back</Button>
              <Button size="lg" className="flex-1 sm:flex-none" onClick={() => setStep(3)}>Continue to Payment</Button>
            </div>
          </>
        )}

        {/* STEP 3 — Payment */}
        {step === 3 && (
          <>
            <SectionCard icon={<CreditCard className="h-5 w-5" />} title="Payment Method" subtitle="Choose your preferred payment method">
              <RadioGroup
                value={paymentMethod}
                onValueChange={(v) => setPaymentMethod(v as "COD")}
                className="grid gap-3"
              >
                {config.codEnabled && (
                  <PaymentOption
                    selected={paymentMethod === "COD"}
                    onSelect={() => setPaymentMethod("COD")}
                    icon={<Banknote className="h-5 w-5" />}
                    title="Cash on Delivery"
                    desc="Pay when you receive your order"
                  />
                )}
                {config.bankTransferEnabled && (
                  <PaymentOption
                    selected={paymentMethod === "BANK_TRANSFER"}
                    onSelect={() => setPaymentMethod("BANK_TRANSFER")}
                    icon={<Landmark className="h-5 w-5" />}
                    title="Bank Transfer"
                    desc="Direct bank transfer — details shared after ordering"
                  />
                )}
                {config.sandboxPaymentEnabled && (
                  <PaymentOption
                    selected={paymentMethod === "ONLINE"}
                    onSelect={() => setPaymentMethod("ONLINE")}
                    icon={<CreditCard className="h-5 w-5" />}
                    title="Online Payment (Sandbox)"
                    desc="Test checkout using Safepay sandbox"
                  />
                )}
                {!config.sandboxPaymentEnabled && (
                  <div className="flex items-center gap-3 rounded-xl border border-dashed p-4 opacity-70">
                    <CreditCard className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold">Online Payment</p>
                      <p className="text-xs text-muted-foreground">Coming soon</p>
                    </div>
                    <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-bold uppercase text-muted-foreground">
                      Disabled
                    </span>
                  </div>
                )}
              </RadioGroup>
            </SectionCard>

            <div className="mt-5 flex justify-between gap-3">
              <Button variant="ghost" className="flex-1 sm:flex-none" onClick={() => setStep(2)}>← Back</Button>
              <Button size="lg" className="flex-1 sm:flex-none" onClick={() => setStep(4)}>Review Order</Button>
            </div>
          </>
        )}

        {/* STEP 4 — Review */}
        {step === 4 && (
          <>
            <SectionCard icon={<ShieldCheck className="h-5 w-5" />} title="Review Your Order" subtitle="Please confirm the details below">
              <div className="grid gap-4 sm:grid-cols-2">
                <ReviewBlock
                  title="Deliver to"
                  onEdit={() => setStep(1)}
                  lines={[
                    activeAddress()?.fullName ?? "",
                    activeAddress()?.line1 ?? "",
                    `${activeAddress()?.city ?? ""}, ${activeAddress()?.province ?? ""} ${activeAddress()?.postalCode ?? ""}`,
                    activeAddress()?.phone ?? "",
                  ].filter(Boolean)}
                />
                <ReviewBlock
                  title="Delivery & Payment"
                  onEdit={() => setStep(2)}
                  lines={[
                    deliveryMethod === "EXPRESS" ? "Express Delivery (1-2 days)" : "Standard Delivery (3-5 days)",
                    paymentMethod === "COD" ? "Cash on Delivery" : paymentMethod === "BANK_TRANSFER" ? "Bank Transfer" : "Online Payment",
                    wrappedUnits > 0
                      ? `Gift wrapping (${wrappedUnits} item${wrappedUnits === 1 ? "" : "s"} — ${formatPKR(quote?.giftWrapCharge ?? config.giftWrapCharge * wrappedUnits)})`
                      : "No gift wrapping",
                  ]}
                />
              </div>

              <Separator className="my-4" />

              <ul className="space-y-3">
                {cartState.items.map((item) => (
                  <li key={item.itemId} className="flex items-center gap-3">
                    <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <Image src={item.image ?? "/images/placeholder.svg"} alt={item.name} fill sizes="56px" className="object-cover" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {item.name}
                        {item.giftWrap && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                            <Gift className="h-2.5 w-2.5" aria-hidden="true" /> Gift wrap
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Qty: {item.quantity} × {formatPKR(item.price)}
                      </p>
                    </div>
                    <span className="text-sm font-bold">{formatPKR(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>

            <div className="mt-5 flex flex-col-reverse items-center justify-between gap-3 sm:flex-row">
              <Button variant="ghost" onClick={() => setStep(3)} disabled={placing}>← Back</Button>
              <Button size="lg" className="h-12 w-full text-base sm:w-auto" onClick={placeOrder} disabled={placing || quoting}>
                {placing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Placing Order...
                  </>
                ) : (
                  <>
                    <Lock className="h-4 w-4" /> Confirm Order — {formatPKR(quote?.total ?? 0)}
                  </>
                )}
              </Button>
            </div>
            <p className="mt-3 text-center text-xs text-muted-foreground sm:text-left">
              Totals are calculated on the server — the amount shown is what you pay.
            </p>
          </>
        )}
      </div>

      {/* ─── Summary sidebar (server quote) ─── */}
      <div className="h-fit rounded-xl border p-5 lg:sticky lg:top-40" aria-live="polite">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Order Summary</h2>
          <span className="text-sm text-muted-foreground">
            {quote?.itemCount ?? cartState.itemCount} item{cartState.itemCount === 1 ? "" : "s"}
          </span>
        </div>

        <ul className="mt-4 max-h-64 space-y-3 overflow-y-auto thin-scrollbar pr-1">
          {cartState.items.map((item) => (
            <li key={item.itemId} className="flex items-center gap-3">
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                <Image src={item.image ?? "/images/placeholder.svg"} alt="" fill sizes="48px" className="object-cover" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.name}</p>
                <p className="text-xs text-muted-foreground">Qty: {item.quantity}</p>
              </div>
              <span className="text-sm font-semibold">{formatPKR(item.lineTotal)}</span>
            </li>
          ))}
        </ul>

        <Separator className="my-4" />

        {/* Coupon (D-06) */}
        <div>
          <Label htmlFor="coupon" className="text-xs text-muted-foreground">Coupon code</Label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="coupon"
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
              placeholder="e.g. WELCOME10"
              className="h-10 uppercase"
            />
            <Button
              type="button"
              variant="secondary"
              className="h-10"
              onClick={() => setCouponCode(couponInput.trim())}
              disabled={!couponInput.trim()}
            >
              Apply
            </Button>
          </div>
          {couponCode && (
            <div className="mt-2 flex items-center justify-between rounded-md bg-brand-50 px-2.5 py-1.5 text-xs">
              <span className="flex items-center gap-1 font-medium text-primary">
                <Tag className="h-3 w-3" /> {couponCode}
                {quote?.couponApplied !== couponCode && (
                  <span className="font-normal text-muted-foreground">— checking…</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => {
                  setCouponCode("");
                  setCouponInput("");
                }}
                aria-label="Remove coupon"
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {quote?.couponError && (
            <p className="mt-1.5 text-xs font-medium text-destructive" role="alert">{quote.couponError}</p>
          )}
        </div>

        <Separator className="my-4" />

        <div className="space-y-2.5 text-sm">
          <Row label="Subtotal" value={formatPKR(quote?.subtotal ?? 0)} />
          {(quote?.discountTotal ?? 0) > 0 && (
            <Row label={`Discount${quote?.couponApplied ? ` (${quote.couponApplied})` : ""}`} value={`− ${formatPKR(quote!.discountTotal)}`} accent />
          )}
          <Row
            label="Delivery Charges"
            value={
              quote === null ? "…" : quote.deliveryFee === 0 ? "FREE" : formatPKR(quote.deliveryFee)
            }
          />
          {(quote?.giftWrapCharge ?? 0) > 0 && (
            <Row
              label={`Gift Wrapping (${quote?.wrappedUnits ?? wrappedUnits} item${(quote?.wrappedUnits ?? wrappedUnits) === 1 ? "" : "s"})`}
              value={formatPKR(quote!.giftWrapCharge)}
            />
          )}
        </div>

        <Separator className="my-4" />

        <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2.5">
          <span className="text-sm font-bold">Total Amount</span>
          <span className="text-xl font-extrabold text-primary">
            {quoting ? <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Updating total" /> : formatPKR(quote?.total ?? 0)}
          </span>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-lg border p-3 text-xs text-muted-foreground">
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          Safe &amp; Secure Checkout — prices and totals are verified on our server before your order is confirmed.
        </div>
      </div>
    </div>
  );
}

// ─── Small building blocks ───

function SectionCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-primary" aria-hidden="true">
          {icon}
        </span>
        <div>
          <h2 className="text-base font-bold">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  error,
  children,
  className,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  // Programmatically associate the label with the field control (a11y:
  // screen readers announce the field name; clicking the label focuses it)
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string }>, { id })
    : children;
  return (
    <div className={className}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="mt-1.5">{control}</div>
      {error && (
        <p className="mt-1 text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DeliveryOption({
  selected,
  onSelect,
  title,
  desc,
  fee,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
  fee: number;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition",
        selected ? "border-primary bg-brand-50 ring-1 ring-primary" : "hover:border-muted-foreground/40"
      )}
    >
      <RadioGroupItem value={title} checked={selected} onClick={onSelect} />
      <Truck className="h-5 w-5 text-primary" aria-hidden="true" />
      <span className="flex-1">
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
      <span className={cn("text-sm font-extrabold", fee === 0 ? "text-primary" : "")}>
        {fee === 0 ? "Free" : formatPKR(fee)}
      </span>
    </Label>
  );
}

function PaymentOption({
  selected,
  onSelect,
  icon,
  title,
  desc,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition",
        selected ? "border-primary bg-brand-50 ring-1 ring-primary" : "hover:border-muted-foreground/40"
      )}
    >
      <RadioGroupItem value={title} checked={selected} onClick={onSelect} />
      <span className="text-primary" aria-hidden="true">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-xs text-muted-foreground">{desc}</span>
      </span>
    </Label>
  );
}

function ReviewBlock({
  title,
  lines,
  onEdit,
}: {
  title: string;
  lines: string[];
  onEdit: () => void;
}) {
  return (
    <div className="rounded-lg border p-3.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">{title}</h3>
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {lines.map((l, i) => (
          <span key={i} className="block">{l}</span>
        ))}
      </p>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold", accent && "text-primary")}>{value}</span>
    </div>
  );
}
