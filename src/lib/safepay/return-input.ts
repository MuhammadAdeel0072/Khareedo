import "server-only";

// Root cause of the "hasTracker: false" return diagnostic: Khareedo hands Safepay a
// redirect_url that already carries `?state=...`, while Safepay appends its tracker with
// a bare `?` (the documented example redirect `.../order/complete?tracker=...` starts
// from a clean URL). URLSearchParams then folds the tracker into the state value.
// This parser makes the return flow robust to every documented/observed merge shape:
//   a) `?state=S&tracker=T`  — correct merge
//   b) `?state=S?tracker=T`  — bare-`?` append (tracker folded into the state value)
//   c) `?tracker=T`          — provider replaced the query; local state survives in the cookie
//   d) no query at all       — cookie state + the DB-bound tracker on the payment row
// No rule here can forge payment state: the signed state is still HMAC-verified and the
// DB lookup still re-validates owner, attempt and amounts before anything is displayed.

export type SafepayReturnQuery = {
  state?: string | string[] | undefined;
  tracker?: string | string[] | undefined;
};

export type SafepayReturnContext =
  | {
      kind: "full";
      trackerToken: string;
      trackerSource: "query" | "state-embedded";
      state: string;
      stateSource: "query" | "cookie";
    }
  | { kind: "tracker-only"; trackerToken: string; trackerSource: "query" | "state-embedded" }
  | { kind: "state-only"; state: string; stateSource: "query" | "cookie" }
  | { kind: "empty" };

const TRACKER_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const EMBEDDED_TRACKER = /[?&]tracker=([^&\s"'<>]+)/;

function first(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) && value.length === 1 && typeof value[0] === "string" ? value[0] : undefined;
}

function validTracker(value: string): string | null {
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })();
  return TRACKER_PATTERN.test(decoded) ? decoded : null;
}

export function parseSafepayReturnContext(
  query: SafepayReturnQuery,
  cookieState: string | undefined,
): SafepayReturnContext {
  const rawTracker = first(query.tracker);
  const rawState = first(query.state);

  // (b) bare-`?` append: the tracker is folded into the state value.
  if (rawState && !rawTracker) {
    const embedded = EMBEDDED_TRACKER.exec(rawState);
    if (embedded) {
      const tracker = validTracker(embedded[1]);
      const state = rawState.slice(0, embedded.index);
      if (tracker && state) {
        return { kind: "full", trackerToken: tracker, trackerSource: "state-embedded",
          state, stateSource: "query" };
      }
    }
  }

  const tracker = rawTracker ? validTracker(rawTracker) : null;
  const state = rawState ?? (cookieState && /^[\x21-\x7e]{1,2048}$/.test(cookieState) ? cookieState : undefined);
  const stateSource: "query" | "cookie" | undefined = rawState !== undefined ? "query"
    : state !== undefined ? "cookie" : undefined;

  if (tracker && state) {
    return { kind: "full", trackerToken: tracker, trackerSource: rawTracker ? "query" : "state-embedded",
      state, stateSource: stateSource! };
  }
  if (tracker) return { kind: "tracker-only", trackerToken: tracker, trackerSource: rawTracker ? "query" : "state-embedded" };
  if (state) return { kind: "state-only", state, stateSource: stateSource! };
  return { kind: "empty" };
}

export const SAFEPAY_RETURN_STATE_COOKIE = "khd_sfpay_return";
