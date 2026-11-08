// Admin payments maintenance — secure MANUAL trigger only.
// There is no cron, no scheduled worker and no public path into these actions; an
// administrator session is mandatory, and an optional shared token (SAFEPAY_MAINTENANCE_TOKEN)
// can additionally be required for server-to-server runners such as a future Vercel Cron.
// Bounded, idempotent sweeps: reservation expiry, provider reconciliation through the
// documented reporter endpoint, and inbox processing of stored webhook events.
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth-guard";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, jsonOk, handleRoute } from "@/lib/api";
import { loadSafepayConfig, SafepayConfigurationError } from "@/lib/safepay/config";
import { createSafepayProvider } from "@/lib/safepay/provider";
import { createSafepayReservationService } from "@/services/safepay-reservations.service";
import { createPaymentWebhookService } from "@/services/payment-webhook.service";
import { createPaymentReconciliationService } from "@/services/payment-reconciliation.service";
import { createPaymentPayloadVault } from "@/lib/payments/payload-vault";
import { loadPaymentPayloadVaultKeys } from "@/lib/payments/vault-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["expire_reservations", "process_webhook_inbox", "reconcile_due_payments"]),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

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
    const { action, limit: batch = 25 } = parsed.data;

    if (action === "expire_reservations") {
      const reservations = createSafepayReservationService(db as never);
      const results = await reservations.expireBatch(batch);
      return jsonOk({ action, batch,
        released: results.filter(r => r.result.ok && r.result.outcome === "RELEASED").length,
        reviewRequired: results.filter(r => r.result.ok && r.result.outcome === "REVIEW_REQUIRED").length,
        failed: results.filter(r => !r.result.ok).length, results });
    }

    const vaultKeys = loadPaymentPayloadVaultKeys();
    if (!vaultKeys) {
      return Response.json({ ok: false, code: "PAYMENT_PAYLOAD_CUSTODY_UNAVAILABLE",
        error: "Payment payload custody keys are not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const vault = createPaymentPayloadVault(vaultKeys.activeKeyId, vaultKeys.keyRing);
    const inbox = createPaymentWebhookService(db as never, vault, { reconcileDelayMs: 60_000 });
    const reconciliation = createPaymentReconciliationService(db as never, inbox);

    if (action === "process_webhook_inbox") {
      const events = await inbox.pending(batch);
      const outcomes: Array<{ eventId: string; result: string }> = [];
      for (const event of events) {
        const processed = await inbox.process(event.id);
        outcomes.push({ eventId: event.id, result: processed.kind });
      }
      return jsonOk({ action, batch, considered: events.length, outcomes });
    }

    // reconcile_due_payments: server-initiated lookup through the documented reporter
    // endpoint for every due managed attempt, then authenticated-observation processing.
    let config;
    try {
      config = loadSafepayConfig();
    } catch (error) {
      if (!(error instanceof SafepayConfigurationError)) throw error;
      return Response.json({ ok: false, code: "SAFEPAY_CONFIGURATION_UNAVAILABLE",
        error: "Safepay server configuration is incomplete." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const due = await reconciliation.due(batch);
    const provider = createSafepayProvider(config);
    const outcomes: Array<{ paymentId: string; outcome: string; code?: string }> = [];
    for (const payment of due) {
      if (payment.provider !== "SAFEPAY" || !payment.trackerToken) continue;
      const fetched = await provider.fetchTracker({ trackerToken: payment.trackerToken });
      if (fetched.kind !== "fetched") {
        outcomes.push({ paymentId: payment.id, outcome: "provider_fetch_failed", code: fetched.code });
        continue;
      }
      const observed = await reconciliation.observe({
        provider: "SAFEPAY", environment: config.environment, merchantAccountRef: config.merchantAccountRef,
        channel: "RECONCILIATION", body: fetched.bodyBytes, headers: {},
      });
      outcomes.push({ paymentId: payment.id, outcome: observed.kind,
        ...("code" in observed ? { code: observed.code } : {}) });
    }
    return jsonOk({ action, batch, considered: due.length, outcomes });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ ok: false, code: error.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
