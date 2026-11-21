// Customer order tracker steps (Phase 3, Chunk 6 — M-5/D3). COD orders are
// CONFIRMED immediately on placement, so PENDING is the first step ("order
// received"): a PENDING order shows its first step done instead of an empty
// tracker (the old steps started at CONFIRMED, so PENDING indexed to -1 and
// nothing was ever marked done). Order status is the source of truth for the
// steps; payment status is rendered as a separate badge, never as a step.
export const TRACK_STEPS = ["PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"] as const;
export type TrackStep = (typeof TRACK_STEPS)[number];

/** Index of the order's current tracker step, or -1 for CANCELLED (the
 * tracker is replaced by the cancellation notice) and unknown statuses. */
export function trackerStepIndex(status: string): number {
  return (TRACK_STEPS as readonly string[]).indexOf(status);
}
