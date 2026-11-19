// Admin MFA status (PR-10). Returns whether the signed-in administrator has
// enrolled in MFA and whether it is enabled. Never includes the TOTP secret,
// recovery codes, or any credential material.
import { requireAdmin } from "@/lib/auth-guard";
import { handleRoute, jsonOk } from "@/lib/api";
import { getAdminMfaStatus } from "@/services/admin-mfa.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () => {
    const user = await requireAdmin();
    const status = await getAdminMfaStatus(user.id);
    return jsonOk({ status });
  });
}
