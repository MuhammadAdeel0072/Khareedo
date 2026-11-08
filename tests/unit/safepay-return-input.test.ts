import { describe, expect, it } from "vitest";
import { parseSafepayReturnContext } from "@/lib/safepay/return-input";

const STATE = "c3RhdGU.value.sig";

describe("Safepay return context parsing", () => {
  it("parses the correctly merged query (?state=S&tracker=T)", () => {
    expect(parseSafepayReturnContext({ state: STATE, tracker: "TCKR_1" }, undefined))
      .toEqual({ kind: "full", trackerToken: "TCKR_1", trackerSource: "query", state: STATE, stateSource: "query" });
  });

  it("recovers the tracker folded into the state value by a bare-? append (?state=S?tracker=T)", () => {
    const folded = `${STATE}?tracker=TCKR_2`;
    expect(parseSafepayReturnContext({ state: folded }, undefined))
      .toEqual({ kind: "full", trackerToken: "TCKR_2", trackerSource: "state-embedded", state: STATE, stateSource: "query" });
  });

  it("falls back to the first-party cookie state when the provider replaced the query (?tracker=T)", () => {
    expect(parseSafepayReturnContext({ tracker: "TCKR_3" }, STATE))
      .toEqual({ kind: "full", trackerToken: "TCKR_3", trackerSource: "query", state: STATE, stateSource: "cookie" });
  });

  it("works with a cookie state and no query at all", () => {
    expect(parseSafepayReturnContext({}, STATE))
      .toEqual({ kind: "state-only", state: STATE, stateSource: "cookie" });
  });

  it("supports a state-only return with the tracker supplied by the local record", () => {
    expect(parseSafepayReturnContext({ state: STATE }, undefined))
      .toEqual({ kind: "state-only", state: STATE, stateSource: "query" });
  });

  it("supports a tracker-only return when no state exists anywhere", () => {
    expect(parseSafepayReturnContext({ tracker: "TCKR_4" }, undefined))
      .toEqual({ kind: "tracker-only", trackerToken: "TCKR_4", trackerSource: "query" });
    expect(parseSafepayReturnContext({}, undefined)).toEqual({ kind: "empty" });
  });

  it("never treats a tracker that fails printable validation as present", () => {
    expect(parseSafepayReturnContext({ tracker: "bad\ntracker" }, undefined)).toEqual({ kind: "empty" });
    expect(parseSafepayReturnContext({ tracker: "" }, STATE)).toEqual({ kind: "state-only", state: STATE, stateSource: "cookie" });
  });

  it("ignores multi-value query parameters instead of guessing", () => {
    expect(parseSafepayReturnContext({ state: ["a", "b"], tracker: "TCKR_5" }, undefined))
      .toEqual({ kind: "tracker-only", trackerToken: "TCKR_5", trackerSource: "query" });
    expect(parseSafepayReturnContext({ state: STATE, tracker: ["x", "y"] }, undefined))
      .toEqual({ kind: "state-only", state: STATE, stateSource: "query" });
  });

  it("prefers an explicit tracker param over the folded form", () => {
    const folded = `${STATE}?tracker=TCKR_FOLDED`;
    expect(parseSafepayReturnContext({ state: folded, tracker: "TCKR_EXPLICIT" }, undefined))
      .toEqual({ kind: "full", trackerToken: "TCKR_EXPLICIT", trackerSource: "query", state: folded, stateSource: "query" });
  });
});
