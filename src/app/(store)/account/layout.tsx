// Account layout — sidebar navigation for customer account pages (FR-05/06).
import { redirect } from "next/navigation";
import { getRequestSession, getSessionUser } from "@/lib/auth-guard";
import { AccountSidebar } from "@/components/account/account-sidebar";

export const dynamic = "force-dynamic";

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequestSession();
  if (!session?.user?.id) redirect("/login?callbackUrl=/account");
  const user = await getSessionUser();

  return (
    <div className="container-khd py-8">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[250px_1fr]">
        <AccountSidebar name={user?.name} email={user?.email} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
