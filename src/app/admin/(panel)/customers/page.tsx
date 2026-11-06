// Admin customers list (FR-45).
import { adminListCustomerSummaries } from "@/services/users.service";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { formatPKR, formatDate, initials } from "@/lib/utils";
import { ExportButtons } from "@/components/admin/export-buttons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customers · Admin" };

export default async function AdminCustomersPage() {
  const customers = await adminListCustomerSummaries();

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">Customers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {customers.length} registered customer{customers.length === 1 ? "" : "s"} (guest checkouts are not listed)
          </p>
        </div>
        <ExportButtons type="customers" formats={["xlsx"]} />
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Customer</th>
              <th className="px-4 py-3 font-semibold">Phone</th>
              <th className="px-4 py-3 font-semibold">Orders</th>
              <th className="px-4 py-3 font-semibold">Total Spent</th>
              <th className="px-4 py-3 font-semibold">Addresses</th>
              <th className="px-4 py-3 font-semibold">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {customers.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarFallback className="bg-primary text-xs font-bold text-primary-foreground">
                          {initials(c.name ?? c.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate font-medium">{c.name ?? "—"}</p>
                        <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.phone ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className="font-semibold">{c.orderCount}</span>
                  </td>
                  <td className="px-4 py-3 font-semibold">{formatPKR(c.totalSpent)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.addressCount}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(c.createdAt)}</td>
                </tr>
            ))}
            {customers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  No registered customers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
