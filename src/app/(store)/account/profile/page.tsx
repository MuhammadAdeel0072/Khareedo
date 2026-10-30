// Profile page (FR-05).
import { redirect } from "next/navigation";
import { getUserProfile } from "@/services/users.service";
import { getSessionUser } from "@/lib/auth-guard";
import { ProfileForm } from "@/components/account/profile-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "My Profile" };

export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?callbackUrl=/account/profile");
  const profile = await getUserProfile(user.id);

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-extrabold tracking-tight">My Profile</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">Manage your personal information</p>
      <div className="rounded-xl border p-6">
        <ProfileForm
          initial={{
            name: profile?.name ?? "",
            email: profile?.email ?? "",
            phone: profile?.phone ?? "",
          }}
        />
      </div>
    </div>
  );
}
