import { PAYMENT_PROVIDER_VERIFICATION_ENABLED } from "@/lib/payments/verification-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard disabled: no body reads, database/config imports, signature guesses or settlement calls.
export async function POST() {
  return Response.json({ ok: false, code: "SAFEPAY_WEBHOOK_VERIFICATION_BLOCKED",
    enabled: PAYMENT_PROVIDER_VERIFICATION_ENABLED,
  }, { status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
