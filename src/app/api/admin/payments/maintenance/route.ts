// Admin payments maintenance â€” secure MANUAL trigger only, plus the shared runner used
// by the in-process background worker (instrumentation.ts). An administrator session is
// mandatory for the HTTP path, and an optional shared token (SAFEPAY_MAINTENANCE_TOKEN)
// can additionally be required for server-to-server runners such as Vercel Cron.
// Bounded, idempotent actions: reservation expiry, provider reconciliation through the
// documented reporter endpoint, inbox processing of stored webhook events, and a
// single-order targeted payment re-check for diagnostics.
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { requireAdmin, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonOk } from "@/lib/api";
import {
  createPaymentMaintenanceRunner,
  MAINTENANCE_ACTIONS,
} from "@/services/payment-maintenance.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(MAINTENANCE_ACTIONS),
  limit: z.number().int().min(1).max(100).optional(),
  // verify_order_payment only: re-check ONE order's payment with Safepay. Never a
  // manual status override â€” the outcome is whatever authenticated provider evidence
  // (or its absence) supports.
  orderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict().refine(
  data => !["verify_order_payment", "investigate_closed_order_payment"].includes(data.action) || typeof data.orderId === "string",
  { message: "orderId is required for verify_order_payment." },
);

const MAINTENANCE_TOKEN_HEADER = "x-khd-maintenance-token";

function maintenanceTokenRequired(): string | null {
  const value = process.env.SAFEPAY_MAINTENANCE_TOKEN;
  if (value === undefined || value.length === 0) return null;
  return /^[^\r\n\s]{16,256}$/.test(value) ? value : null;
}

function tokenMatches(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    const user = await requireAdmin();
    const limit = rateLimit(`payments-maintenance:${user.id}`, 10, 60_000);
    if (!limit.ok) {
      return Response.json({ ok: false, code: "RATE_LIMITED", error: `Too many maintenance calls. Retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    const expectedToken = maintenanceTokenRequired();
    if (expectedToken && !tokenMatches(request.headers.get(MAINTENANCE_TOKEN_HEADER), expectedToken)) {
      return Response.json({ ok: false, code: "MAINTENANCE_TOKEN_REQUIRED", error: "Maintenance token header required." },
        { status: 403, headers: { "Cache-Control": "no-store" } });
    }

    const parsed = await parseBody(request, bodySchema);
    if (parsed.error) return parsed.error;
    const { action, limit: batch = 25, orderId } = parsed.data;

    const runner = createPaymentMaintenanceRunner();
    const result = await runner.run(action, batch, orderId ? { orderId } : undefined);
    const response = jsonOk(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}


