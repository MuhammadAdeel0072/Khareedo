// Unit test — customer order tracker steps (Phase 3, Chunk 6 — M-5/D3).
// COD orders are CONFIRMED on placement, so PENDING is the first step
// ("order received"): a PENDING order shows its first step done instead of
// an empty tracker (the old steps started at CONFIRMED, so PENDING indexed
// to -1 and nothing was ever marked done).
import { describe, expect, it } from "vitest";
import { TRACK_STEPS, trackerStepIndex } from "@/lib/order-tracking";

describe("trackerStepIndex", () => {
  it("starts at PENDING — the order-received step", () => {
    expect(TRACK_STEPS[0]).toBe("PENDING");
    expect(trackerStepIndex("PENDING")).toBe(0);
  });

  it("marks a CONFIRMED COD order as confirmed (first two steps done)", () => {
    expect(trackerStepIndex("CONFIRMED")).toBe(1);
  });

  it("advances through PROCESSING, SHIPPED, DELIVERED", () => {
    expect(trackerStepIndex("PROCESSING")).toBe(2);
    expect(trackerStepIndex("SHIPPED")).toBe(3);
    expect(trackerStepIndex("DELIVERED")).toBe(4);
  });

  it("returns -1 for CANCELLED and unknown statuses (no tracker)", () => {
    expect(trackerStepIndex("CANCELLED")).toBe(-1);
    expect(trackerStepIndex("BOGUS")).toBe(-1);
  });
});
