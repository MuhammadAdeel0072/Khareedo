import "server-only";
import { z } from "zod";

export const localId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const checkoutRequestSchema = z.object({
  orderId: localId,
  paymentId: localId,
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
}).strict();
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

const token = z.string().min(1).max(2048).refine(v => !/[\u0000-\u0020\u007f]/.test(v));
const envelope = z.object({ errors: z.array(z.unknown()), message: z.string().optional() });
export const trackerResponseSchema = z.object({
  data: z.object({
    tracker: z.object({
      token, environment: z.enum(["sandbox", "production"]), state: z.string().min(1).max(128),
      intent: z.string().min(1).max(32), mode: z.string().min(1).max(32), entry_mode: z.string().min(1).max(32),
      purchase_totals: z.object({
        quote_amount: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.number().int().nonnegative().refine(Number.isSafeInteger) }),
      }),
    }),
    capabilities: z.object({ CYBERSOURCE: z.boolean() }),
  }),
  status: envelope,
});
export const authResponseSchema = z.object({ data: token, status: envelope.optional() });

// Documented classic refund endpoint response: updated tracker state and purchase
// totals. Parsing is advisory-only (extraction of the tracker state); a 2xx response
// with an unparsable body is still an accepted submission — final accounting is
// never derived from this response, only from authenticated evidence.
export const refundResponseSchema = z.object({
  data: z.object({
    tracker: z.object({
      token: token.optional(),
      state: z.string().min(1).max(128).optional(),
      purchase_totals: z.object({
        quote_amount: z.object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: z.number().int().nonnegative().refine(Number.isSafeInteger),
        }).passthrough(),
      }).passthrough().optional(),
    }).passthrough(),
  }).passthrough(),
  status: envelope.optional(),
}).passthrough();

export type Tracker = Readonly<{
  token: string; environment: string; state: string; intent: string;
  mode: string; entryMode: string; currency: string; amountMinor: bigint;
}>;
export type ProviderErrorCode = "INVALID_REQUEST" | "TIMEOUT" | "NETWORK_ERROR" | "HTTP_ERROR" |
  "INVALID_RESPONSE" | "TRACKER_MISMATCH" | "REFUND_MISMATCH";
export type ProviderFailure = Readonly<{
  kind: "failed" | "uncertain"; code: ProviderErrorCode; httpStatus?: number; tracker?: Tracker;
  providerErrorCode?: string; providerMessage?: string;
}>;

export function wholePkrToMinor(total: number): bigint {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(total * 100)) {
    throw new Error("Invalid PKR amount.");
  }
  return BigInt(total) * BigInt(100);
}
