// Client-side fetch with a deadline.
//
// Browser fetch() has no timeout: a stalled request hangs the UI
// forever (no spinner ever resolves, no error ever surfaces). This
// wrapper aborts after `timeoutMs` and throws a FetchTimeoutError whose
// message is safe to show the user. It changes nothing about a request
// that answers in time — same Response, same behaviour — and it honours
// a caller-provided AbortSignal: a caller abort rethrows the caller's
// abort untouched, it is never re-labelled as a timeout.
//
// Timeouts are deliberately generous: the checkout transaction alone
// may take up to 15s server-side, so the place-order call passes 20s.
// Adopted in the client mutations (add-to-cart, cart edits, place order)
// and in the checkout flow's remaining calls (gift-wrap / quantity PATCH,
// server quote, address save): every user-initiated fetch in the cart /
// checkout flow now has a deadline, so a stalled request surfaces an error
// instead of hanging the UI forever.
export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs / 1000}s. Please try again.`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Default deadline for client mutations (15s). */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** Deadline for place-order: the server transaction may run up to 15s. */
export const CHECKOUT_FETCH_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = init.signal;
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    // A controller abort while the caller's own signal is still live is
    // our timeout. A caller abort rethrows as-is — never re-labelled.
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
