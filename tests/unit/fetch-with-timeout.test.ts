// fetchWithTimeout (src/lib/fetch-with-timeout.ts).
//
// A fetch that answers in time behaves exactly like plain fetch; a
// fetch that stalls past the deadline rejects with FetchTimeoutError;
// a caller abort is never re-labelled as a timeout.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECKOUT_FETCH_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  FetchTimeoutError,
  fetchWithTimeout,
} from "@/lib/fetch-with-timeout";

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/** A fetch mock that never settles on its own — it only rejects when its signal aborts. */
function hangingFetch() {
  return vi.fn((_input: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      });
    });
  });
}

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes a fast response through unchanged", async () => {
    const mock = vi.fn(async (_input: unknown, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", mock);
    const res = await fetchWithTimeout("/api/cart", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledOnce();
    const passedInit = mock.mock.calls[0][1] as RequestInit | undefined;
    if (!passedInit) throw new Error("expected fetch to be called with init");
    expect(passedInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with FetchTimeoutError when the request stalls past the deadline", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(fetchWithTimeout("/api/cart", {}, 10)).rejects.toBeInstanceOf(FetchTimeoutError);
    await expect(fetchWithTimeout("/api/cart", {}, 10)).rejects.toThrow(
      "Request timed out after 0.01s. Please try again."
    );
  });

  it("does not re-label a caller abort as a timeout", async () => {
    const controller = new AbortController();
    const mock = vi.fn((_input: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", mock);
    const pending = fetchWithTimeout("/api/cart", { signal: controller.signal }, 60_000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending).rejects.not.toBeInstanceOf(FetchTimeoutError);
  });

  it("passes non-abort fetch failures through untouched", async () => {
    const failure = new TypeError("network down");
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
    await expect(fetchWithTimeout("/api/cart", {}, 1000)).rejects.toBe(failure);
  });

  it("uses a 15s default and a 20s checkout deadline", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(CHECKOUT_FETCH_TIMEOUT_MS).toBe(20_000);
  });
});
