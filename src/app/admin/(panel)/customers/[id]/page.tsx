// Admin customer detail — drill-down from the customers list (FR-45).
// Read-only: profile, saved addresses and recent orders with totals.
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { adminGetCustomerById } from "@/services/users.service";
import { formatPKR, formatDate, formatDateTime } from "@/lib/utils";
import { STATUS_BADGE_CLASSES } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer · Admin" };

export default async function AdminCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const customer = await adminGetCustomerById(id);
  if (!customer) notFound();

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <Button asChild variant="ghost" className="mb-4 -ml-2">
        <Link href="/admin/customers">
          <ArrowLeft className="h-4 w-4" /> All Customers
        </Link>
      </Button>

      <div className="mb-5">
        <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">{customer.name ?? "—"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {customer.email} · joined {formatDate(customer.createdAt)}
          {customer.emailVerified ? " · email verified" : " · email not verified"}
        </p>
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Orders</p>
          <p className="mt-1 text-2xl font-extrabold">{customer.orderCount}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total spent</p>
          <p className="mt-1 text-2xl font-extrabold">{formatPKR(customer.totalSpent)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Addresses</p>
          <p className="mt-1 text-2xl font-extrabold">{customer.addresses.length}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-bold">Saved addresses</h2>
          {customer.addresses.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No saved addresses.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {customer.addresses.map((a) => (
                <li key={a.id} className="rounded-lg border p-3 text-sm leading-6 text-muted-foreground">
                  <span className="font-medium text-foreground">{a.fullName}</span>
                  {a.isDefault && (
                    <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">Default</span>
                  )}
                  <br />
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ""}
                  <br />
                  {a.city}, {a.province} {a.postalCode ?? ""} · {a.phone}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-bold">Recent orders</h2>
          {customer.orders.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {customer.orders.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2 rounded-lg border p-3">
                  <div className="min-w-0">
                    <Link href={`/admin/orders/${o.id}`} className="font-mono text-xs font-bold text-primary hover:underline">
                      {o.reference}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDateTime(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"} · {o.paymentMethod} · {o.paymentStatus}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline" className={STATUS_BADGE_CLASSES[o.status] ?? ""}>
                      {o.status}
                    </Badge>
                    <span className="text-sm font-bold">{formatPKR(o.total)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
