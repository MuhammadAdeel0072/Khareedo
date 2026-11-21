// Delivery and returns claims, defined once (Phase 3, chunk 12 follow-up B).
//
// The PDP claimed "2-5 working days" while checkout offered Standard
// "3 - 5 working days" / Express "1 - 2 working days", and the returns
// window ("Within 7 days") was hardcoded in one place with no shared
// definition. These constants are the single source of truth — the PDP,
// the checkout delivery options and the review step all render from them,
// so the store can never promise two different delivery windows again.
//
// NOTE: there is no returns flow (no RMA, no return endpoint) — the
// "Within 7 days" window is a service promise, not a flow. Do not invent
// a returns flow from this file; changing the promise means changing the
// policy first.
export const STANDARD_DELIVERY_WINDOW = "3 - 5 working days";
export const EXPRESS_DELIVERY_WINDOW = "1 - 2 working days";
export const STANDARD_DELIVERY_SHORT = "3-5 days";
export const EXPRESS_DELIVERY_SHORT = "1-2 days";
export const RETURNS_WINDOW = "Within 7 days";
